/**
 * The supervisor that answers approval requests during an unattended job.
 *
 * Job steps run in `approval-required`, so the provider genuinely asks
 * (ADR-0008). With no human at the keyboard, a supervisor model answers —
 * approve, deny, or escalate — and escalation is the honest answer to
 * uncertainty: it pauses the job somewhere visible rather than guessing.
 *
 * Attached per step, in the step's own scope, alongside the settle watch. That
 * scoping is deliberate: the supervisor can only ever act on threads the
 * runner created, so nothing it does can reach a thread a human is driving.
 *
 * @module jobs/supervisor
 */
import {
  CommandId,
  EventId,
  type ApprovalRequestId,
  type ModelSelection,
  type OrchestrationEvent,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  ApprovalRequestedActivityPayload,
  classifyApprovalRequest,
} from "./approvalClassification.ts";

/** The activity kind a verdict is recorded under. */
export const SUPERVISOR_VERDICT_ACTIVITY_KIND = "job.supervisor.verdict";

export type SupervisorVerdict = "approve" | "deny" | "escalate";

const decodeApprovalPayload = Schema.decodeUnknownEffect(ApprovalRequestedActivityPayload);

function isApprovalRequested(
  event: OrchestrationEvent,
  threadId: ThreadId,
): event is Extract<OrchestrationEvent, { readonly type: "thread.activity-appended" }> {
  return (
    event.type === "thread.activity-appended" &&
    event.payload.threadId === threadId &&
    event.payload.activity.kind === "approval.requested"
  );
}

/**
 * Watch a thread and answer its approval requests until the enclosing scope
 * closes.
 *
 * Escalation is the absence of a response: the request stays pending, the
 * thread keeps reporting `waiting_for_approval` up the awareness feed, and a
 * human resolves it through the ordinary steering path. There is deliberately
 * no timeout — a paused job is meant to be visible, and a clock that resolved
 * it would be making exactly the decision the supervisor declined to make.
 */
export const attachApprovalSupervisor = Effect.fn("attachApprovalSupervisor")(function* (input: {
  readonly engine: OrchestrationEngineShape;
  readonly textGeneration: TextGeneration["Service"];
  readonly crypto: Crypto.Crypto;
  readonly threadId: ThreadId;
  readonly stepInstruction: string;
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
}) {
  const { engine, textGeneration, crypto, threadId, stepInstruction, cwd, modelSelection } = input;

  // The engine republishes persisted events after a dispatch failure, so the
  // same request can arrive twice. Answering twice would mean a second model
  // call and a second response to a request already settled.
  const answered = new Set<string>();

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:supervisor-${tag}:${uuid}`)),
    );

  const recordVerdict = Effect.fn("attachApprovalSupervisor.recordVerdict")(function* (record: {
    readonly requestId: ApprovalRequestId;
    readonly requestType: string | undefined;
    readonly verdict: SupervisorVerdict;
    readonly reasoning: string;
    readonly consultedModel: boolean;
  }) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: yield* commandId("verdict"),
      threadId,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        // `approval` rather than `info` for anything that was not a plain yes:
        // ADR-0007 makes visibility the control, so a denial or an escalation
        // has to read as a decision someone made.
        tone: record.verdict === "approve" ? "info" : "approval",
        kind: SUPERVISOR_VERDICT_ACTIVITY_KIND,
        summary: `Supervisor ${record.verdict === "escalate" ? "escalated" : `${record.verdict}d`} an approval request`,
        payload: {
          requestId: record.requestId,
          ...(record.requestType === undefined ? {} : { requestType: record.requestType }),
          verdict: record.verdict,
          reasoning: record.reasoning,
          consultedModel: record.consultedModel,
        },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  const respond = Effect.fn("attachApprovalSupervisor.respond")(function* (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) {
    // Always through the command, never the provider service directly: only
    // the command produces `thread.approval-response-requested`, which is what
    // marks the pending-approval projection resolved.
    yield* engine.dispatch({
      type: "thread.approval.respond",
      commandId: yield* commandId("respond"),
      threadId,
      requestId,
      decision,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const handle = Effect.fn("attachApprovalSupervisor.handle")(function* (
    event: Extract<OrchestrationEvent, { readonly type: "thread.activity-appended" }>,
  ) {
    const payload = yield* decodeApprovalPayload(event.payload.activity.payload).pipe(
      Effect.option,
    );
    if (payload._tag === "None") {
      // An approval whose payload will not decode cannot be judged, and
      // guessing is the one thing a supervisor must not do. Leaving it pending
      // escalates it to a human.
      yield* Effect.logWarning("supervisor could not decode an approval request; escalating", {
        threadId,
        activityId: event.payload.activity.id,
      });
      return;
    }
    const { requestId, requestType, detail } = payload.value;
    if (answered.has(requestId)) {
      return;
    }
    answered.add(requestId);

    const disposition = classifyApprovalRequest({ requestType, detail });

    // The verdict is always recorded before it is acted on, so "why did the
    // agent do that" stays answerable even if the response never lands.
    if (disposition.kind === "auto-approve") {
      yield* recordVerdict({
        requestId,
        requestType,
        verdict: "approve",
        reasoning: disposition.reason,
        consultedModel: false,
      });
      yield* respond(requestId, "accept");
      return;
    }

    if (disposition.kind === "deny") {
      yield* recordVerdict({
        requestId,
        requestType,
        verdict: "deny",
        reasoning: disposition.reason,
        consultedModel: false,
      });
      yield* respond(requestId, "decline");
      return;
    }

    const generated = yield* textGeneration
      .generateApprovalVerdict({
        cwd,
        toolKind: disposition.toolKind,
        requestType: requestType ?? "unknown",
        ...(detail === undefined ? {} : { requestDetail: detail }),
        stepInstruction,
        modelSelection,
      })
      .pipe(Effect.option);

    if (generated._tag === "None") {
      // A supervisor that cannot be reached has not approved anything.
      yield* Effect.logWarning("supervisor model call failed; escalating", { threadId, requestId });
      yield* recordVerdict({
        requestId,
        requestType,
        verdict: "escalate",
        reasoning: "The supervisor model could not be reached.",
        consultedModel: true,
      });
      return;
    }

    const { verdict, reasoning } = generated.value;
    yield* recordVerdict({ requestId, requestType, verdict, reasoning, consultedModel: true });

    if (verdict === "escalate") {
      // Deliberately no response: the request stays pending, the thread reads
      // as waiting_for_approval, and a human decides.
      yield* Effect.logInfo("supervisor escalated an approval request", {
        threadId,
        requestId,
        reasoning,
      });
      return;
    }

    // A denial feeds back to the agent with its reasoning, exactly as a human
    // denial does, and does not fail the step — a supervisor that killed the
    // job on first denial would make pipelines brittle.
    yield* respond(requestId, verdict === "approve" ? "accept" : "decline");
  });

  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      isApprovalRequested(event, threadId)
        ? handle(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("supervisor failed to answer an approval request", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          )
        : Effect.void,
    ),
    { startImmediately: true },
  );
}) satisfies (input: {
  readonly engine: OrchestrationEngineShape;
  readonly textGeneration: TextGeneration["Service"];
  readonly crypto: Crypto.Crypto;
  readonly threadId: ThreadId;
  readonly stepInstruction: string;
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
}) => Effect.Effect<void, never, Scope.Scope>;
