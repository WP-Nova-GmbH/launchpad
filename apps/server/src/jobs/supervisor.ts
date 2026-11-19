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
  ApprovalRequestId,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RunRepositoryWorkflow, WorkflowAgentStep } from "@t3tools/contracts/workflows";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  WORKFLOW_APPROVAL_FAILURE_DETAILS,
  type TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import {
  ApprovalRequestedActivityPayload,
  classifyApprovalRequest,
} from "./approvalClassification.ts";

/** The activity kind a verdict is recorded under. */
export const SUPERVISOR_VERDICT_ACTIVITY_KIND = "job.supervisor.verdict";

export type SupervisorVerdict = "approve" | "deny" | "escalate";

const decodeApprovalPayload = Schema.decodeUnknownEffect(ApprovalRequestedActivityPayload);
const decodeUserInput = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: ApprovalRequestId,
    responseMode: Schema.optional(Schema.Literal("message")),
  }),
);
const decodeWorkflowTask = Schema.decodeUnknownOption(
  Schema.Struct({
    stepInstruction: WorkflowAgentStep.fields.instruction,
    jobContext: RunRepositoryWorkflow.fields.instruction,
    reviewConstraint: Schema.String.check(Schema.isMaxLength(1_000)),
  }),
);

/**
 * Watch a thread and answer its approval requests until the enclosing scope
 * closes.
 *
 * Escalated requests stay pending when a human can steer the thread. Workflow
 * VMs expose a read-only result, so their supervisor declines those requests.
 */
export const attachApprovalSupervisor = Effect.fn("attachApprovalSupervisor")(function* (input: {
  readonly engine: OrchestrationEngineShape;
  readonly textGeneration: TextGeneration["Service"];
  readonly crypto: Crypto.Crypto;
  readonly threadId: ThreadId;
  readonly stepInstruction: string;
  readonly cwd: string;
  readonly resolveCwd?: Effect.Effect<string | null>;
  readonly jobContext?: string | undefined;
  readonly reviewConstraint?: string | undefined;
  readonly modelSelection: ModelSelection;
  readonly workflowVm?: boolean;
  readonly replayEvents?: Stream.Stream<OrchestrationEvent>;
  readonly liveEvents?: Stream.Stream<OrchestrationEvent>;
  readonly resolvedRequestIds?: ReadonlySet<string>;
  readonly resolvedUserInputIds?: ReadonlySet<string>;
  readonly recordedVerdicts?: ReadonlyMap<string, SupervisorVerdict>;
}) {
  const { engine, textGeneration, crypto, threadId, stepInstruction, cwd, modelSelection } = input;

  // The engine republishes persisted events after a dispatch failure, so the
  // same request can arrive twice. Answering twice would mean a second model
  // call and a second response to a request already settled.
  const answered = new Set(input.resolvedRequestIds);
  const answeredUserInputs = new Set(input.resolvedUserInputIds);

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
        summary: `Supervisor ${record.verdict === "deny" ? "denied" : `${record.verdict}d`} an approval request`,
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
      commandId:
        input.replayEvents === undefined
          ? yield* commandId("respond")
          : CommandId.make(`server:supervisor:${threadId}:${requestId}:respond`),
      threadId,
      requestId,
      decision,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const settleVerdict = Effect.fnUntraced(function* (record: Parameters<typeof recordVerdict>[0]) {
    const decline = record.verdict === "escalate" && input.workflowVm;
    const verdict = decline ? "deny" : record.verdict;
    yield* recordVerdict(
      decline
        ? {
            ...record,
            verdict,
            reasoning: `${record.reasoning} Workflow VM tool approvals cannot be handed to a human.`,
          }
        : record,
    );
    if (verdict === "escalate") {
      yield* Effect.logInfo("supervisor escalated an approval request", {
        threadId,
        requestId: record.requestId,
        reasoning: record.reasoning,
      });
      return;
    }
    // A denial lets the agent try another approach without ending the step.
    yield* respond(record.requestId, verdict === "approve" ? "accept" : "decline");
  });

  const handleApproval = Effect.fn("attachApprovalSupervisor.handle")(function* (
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

    const recorded = input.recordedVerdicts?.get(requestId);
    if (recorded !== undefined) {
      if (recorded !== "escalate" || input.workflowVm)
        yield* respond(requestId, recorded === "approve" ? "accept" : "decline");
      return;
    }
    const disposition = classifyApprovalRequest({ requestType, detail });

    // The verdict is always recorded before it is acted on, so "why did the
    // agent do that" stays answerable even if the response never lands.
    if (disposition.kind === "auto-approve") {
      return yield* settleVerdict({
        requestId,
        requestType,
        verdict: "approve",
        reasoning: disposition.reason,
        consultedModel: false,
      });
    }

    if (disposition.kind === "deny") {
      return yield* settleVerdict({
        requestId,
        requestType,
        verdict: "deny",
        reasoning: disposition.reason,
        consultedModel: false,
      });
    }

    const actualCwd = input.resolveCwd ? yield* input.resolveCwd : cwd;
    const validTask = input.jobContext === undefined || Option.isSome(decodeWorkflowTask(input));
    if (!actualCwd || !validTask) {
      return yield* settleVerdict({
        requestId,
        requestType,
        verdict: "escalate",
        reasoning: !actualCwd
          ? "The job's prepared workspace is unavailable."
          : "The saved workflow task is invalid or exceeds its supported length.",
        consultedModel: false,
      });
    }
    const generated = yield* textGeneration
      .generateApprovalVerdict({
        cwd: actualCwd,
        toolKind: disposition.toolKind,
        requestType: requestType ?? "unknown",
        ...(detail === undefined ? {} : { requestDetail: detail }),
        stepInstruction,
        ...(input.jobContext === undefined
          ? {}
          : { jobContext: input.jobContext, reviewConstraint: input.reviewConstraint }),
        modelSelection,
      })
      .pipe(Effect.result);

    if (generated._tag === "Failure") {
      const failure = Object.entries(WORKFLOW_APPROVAL_FAILURE_DETAILS).find(
        ([, detail]) => detail === generated.failure.detail,
      );
      // Persist only our fixed explanations, never provider error bodies or causes.
      yield* Effect.logWarning("supervisor model call failed", {
        threadId,
        requestId,
        failureKind: failure?.[0] ?? "unavailable",
      });
      return yield* settleVerdict({
        requestId,
        requestType,
        verdict: "escalate",
        reasoning: failure?.[1] ?? "The supervisor model did not return a usable approval verdict.",
        consultedModel: true,
      });
    }

    const { verdict, reasoning } = generated.success;
    yield* settleVerdict({ requestId, requestType, verdict, reasoning, consultedModel: true });
  });

  const handleUserInput = Effect.fnUntraced(function* (payload: unknown) {
    const request = decodeUserInput(payload);
    if (Option.isNone(request) || request.value.responseMode === "message") return;
    const { requestId } = request.value;
    if (answeredUserInputs.has(requestId)) return;
    // A native callback blocks the turn. Return no answers so Codex can continue
    // without choosing on the user's behalf. Async questions do not block it.
    yield* engine.dispatch({
      type: "thread.user-input.respond",
      commandId: CommandId.make(`server:supervisor:${threadId}:${requestId}:user-input`),
      threadId,
      requestId,
      answers: {},
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    answeredUserInputs.add(requestId);
  });

  const events =
    input.replayEvents === undefined
      ? engine.streamDomainEvents
      : Stream.concat(
          input.replayEvents,
          input.liveEvents ?? (yield* engine.subscribeDomainEvents),
        );
  yield* Effect.forkScoped(
    Stream.runForEach(events, (event) => {
      if (event.type !== "thread.activity-appended" || event.payload.threadId !== threadId)
        return Effect.void;
      const activity = event.payload.activity;
      const handle =
        activity.kind === "approval.requested"
          ? handleApproval(event)
          : input.workflowVm && activity.kind === "user-input.requested"
            ? handleUserInput(activity.payload)
            : Effect.void;
      return handle.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("supervisor failed to answer a provider request", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }),
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
  readonly workflowVm?: boolean;
  readonly replayEvents?: Stream.Stream<OrchestrationEvent>;
  readonly liveEvents?: Stream.Stream<OrchestrationEvent>;
  readonly resolvedRequestIds?: ReadonlySet<string>;
  readonly resolvedUserInputIds?: ReadonlySet<string>;
  readonly recordedVerdicts?: ReadonlyMap<string, SupervisorVerdict>;
}) => Effect.Effect<void, never, Scope.Scope>;
