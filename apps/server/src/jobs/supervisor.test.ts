import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Crypto from "effect/Crypto";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type {
  ApprovalVerdictGenerationInput,
  ApprovalVerdictGenerationResult,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import { attachApprovalSupervisor, SUPERVISOR_VERDICT_ACTIVITY_KIND } from "./supervisor.ts";

const THREAD_ID = ThreadId.make("thread-supervised");
const NOW = "2026-05-01T00:00:00.000Z";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.3-codex",
};

let nextSequence = 0;

function approvalRequestedEvent(input: {
  readonly requestId: string;
  readonly requestType?: string;
  readonly detail?: string;
  readonly threadId?: ThreadId;
  readonly payloadOverride?: unknown;
}): OrchestrationEvent {
  nextSequence += 1;
  const threadId = input.threadId ?? THREAD_ID;
  return {
    sequence: nextSequence,
    eventId: EventId.make(`evt-${nextSequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.make(`activity-${nextSequence}`),
        tone: "approval",
        kind: "approval.requested",
        summary: "Approval requested",
        payload: input.payloadOverride ?? {
          requestId: input.requestId,
          ...(input.requestType === undefined ? {} : { requestType: input.requestType }),
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        },
        turnId: null,
        createdAt: NOW,
      },
    },
  };
}

interface SupervisorHarnessOptions {
  readonly verdict?: (
    input: ApprovalVerdictGenerationInput,
  ) => ApprovalVerdictGenerationResult | "fail";
}

interface SupervisorHarness {
  readonly engine: OrchestrationEngineShape;
  readonly textGeneration: TextGeneration["Service"];
  readonly emit: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly modelCalls: Ref.Ref<ReadonlyArray<ApprovalVerdictGenerationInput>>;
  readonly awaitDispatch: (
    predicate: (command: OrchestrationCommand) => boolean,
  ) => Effect.Effect<OrchestrationCommand>;
}

const makeHarness = (options: SupervisorHarnessOptions = {}): Effect.Effect<SupervisorHarness> =>
  Effect.gen(function* () {
    const pubSub = yield* PubSub.unbounded<OrchestrationEvent>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const modelCalls = yield* Ref.make<ReadonlyArray<ApprovalVerdictGenerationInput>>([]);
    // Every dispatch is announced here, so a test can wait on the supervisor
    // having acted instead of sleeping and hoping.
    const dispatchSignals = yield* Queue.unbounded<OrchestrationCommand>();

    const engine: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      latestSequence: Effect.succeed(0),
      get streamDomainEvents() {
        return Stream.fromPubSub(pubSub);
      },
      dispatch: (command) =>
        Ref.update(dispatched, (all) => [...all, command]).pipe(
          Effect.andThen(Queue.offer(dispatchSignals, command)),
          Effect.as({ sequence: 0 }),
        ),
    };

    const textGeneration = {
      generateApprovalVerdict: (input: ApprovalVerdictGenerationInput) =>
        Ref.update(modelCalls, (all) => [...all, input]).pipe(
          Effect.andThen(() => {
            const answer = options.verdict?.(input) ?? {
              verdict: "approve" as const,
              reasoning: "looks routine",
            };
            return answer === "fail"
              ? Effect.fail(new Error("model unavailable") as never)
              : Effect.succeed(answer);
          }),
        ),
    } as unknown as TextGeneration["Service"];

    const emit = (event: OrchestrationEvent) => PubSub.publish(pubSub, event).pipe(Effect.asVoid);

    /** Wait until a dispatch matching the predicate has happened. */
    const awaitDispatch = (predicate: (command: OrchestrationCommand) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const command = yield* Queue.take(dispatchSignals);
          if (predicate(command)) {
            return command;
          }
        }
      });

    return {
      engine,
      textGeneration,
      emit,
      dispatched,
      modelCalls,
      awaitDispatch,
    } satisfies SupervisorHarness;
  });

const isVerdictActivity = (command: OrchestrationCommand) =>
  command.type === "thread.activity.append" &&
  command.activity.kind === SUPERVISOR_VERDICT_ACTIVITY_KIND;

const isApprovalResponse = (command: OrchestrationCommand) =>
  command.type === "thread.approval.respond";

function withSupervisor<A>(
  options: SupervisorHarnessOptions,
  use: (harness: SupervisorHarness) => Effect.Effect<A>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(options);
      yield* attachApprovalSupervisor({
        engine: harness.engine,
        textGeneration: harness.textGeneration,
        crypto: yield* Crypto.Crypto,
        threadId: THREAD_ID,
        stepInstruction: "Add a health endpoint",
        cwd: "/tmp/worktree",
        modelSelection: MODEL_SELECTION,
      });
      return yield* use(harness);
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

it.effect("auto-approves a file read without consulting the model", () =>
  Effect.gen(function* () {
    const { decisions, modelCalls } = yield* withSupervisor({}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-read",
            requestType: "file_read_approval",
            detail: "read src/a.ts",
          }),
        );
        yield* harness.awaitDispatch(isApprovalResponse);
        return {
          decisions: yield* Ref.get(harness.dispatched),
          modelCalls: yield* Ref.get(harness.modelCalls),
        };
      }),
    );

    const response = decisions.find(isApprovalResponse);
    assert.equal(response?.type === "thread.approval.respond" ? response.decision : null, "accept");
    assert.equal(modelCalls.length, 0);
  }),
);

it.effect("denies a push outright, without consulting the model", () =>
  Effect.gen(function* () {
    // ADR-0009: the runner pushes, so a push from an agent needs no judgement.
    const { decisions, modelCalls } = yield* withSupervisor({}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-push",
            requestType: "command_execution_approval",
            detail: "git push origin HEAD",
          }),
        );
        yield* harness.awaitDispatch(isApprovalResponse);
        return {
          decisions: yield* Ref.get(harness.dispatched),
          modelCalls: yield* Ref.get(harness.modelCalls),
        };
      }),
    );

    const response = decisions.find(isApprovalResponse);
    assert.equal(
      response?.type === "thread.approval.respond" ? response.decision : null,
      "decline",
    );
    assert.equal(modelCalls.length, 0);
  }),
);

it.effect("consults the model for an ordinary command and accepts its approval", () =>
  Effect.gen(function* () {
    const { decisions, modelCalls } = yield* withSupervisor({}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-cmd",
            requestType: "command_execution_approval",
            detail: "pnpm test",
          }),
        );
        yield* harness.awaitDispatch(isApprovalResponse);
        return {
          decisions: yield* Ref.get(harness.dispatched),
          modelCalls: yield* Ref.get(harness.modelCalls),
        };
      }),
    );

    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0]?.toolKind, "command");
    assert.equal(modelCalls[0]?.stepInstruction, "Add a health endpoint");
    const response = decisions.find(isApprovalResponse);
    assert.equal(response?.type === "thread.approval.respond" ? response.decision : null, "accept");
  }),
);

it.effect("declines when the model denies, and does not end the step", () =>
  Effect.gen(function* () {
    const { decisions } = yield* withSupervisor(
      { verdict: () => ({ verdict: "deny", reasoning: "unrelated to the task" }) },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.emit(
            approvalRequestedEvent({
              requestId: "req-deny",
              requestType: "command_execution_approval",
              detail: "rm -rf node_modules",
            }),
          );
          yield* harness.awaitDispatch(isApprovalResponse);
          return { decisions: yield* Ref.get(harness.dispatched) };
        }),
    );

    const response = decisions.find(isApprovalResponse);
    assert.equal(
      response?.type === "thread.approval.respond" ? response.decision : null,
      "decline",
    );
  }),
);

it.effect("leaves an escalated request pending so a human resolves it", () =>
  Effect.gen(function* () {
    // Escalation is the absence of a response. To assert an absence without a
    // timeout, a second request that IS answered is emitted afterwards: the
    // supervisor handles events in order, so once the second has been
    // responded to, the first is definitively finished.
    const { decisions } = yield* withSupervisor(
      {
        verdict: (input) =>
          input.requestDetail?.includes("migrate")
            ? { verdict: "escalate", reasoning: "cannot tell if this is destructive" }
            : { verdict: "approve", reasoning: "routine" },
      },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.emit(
            approvalRequestedEvent({
              requestId: "req-escalate",
              requestType: "command_execution_approval",
              detail: "pnpm db migrate --force",
            }),
          );
          yield* harness.emit(
            approvalRequestedEvent({
              requestId: "req-after",
              requestType: "file_read_approval",
              detail: "read src/a.ts",
            }),
          );
          yield* harness.awaitDispatch(
            (command) => isApprovalResponse(command) && command.requestId === "req-after",
          );
          return { decisions: yield* Ref.get(harness.dispatched) };
        }),
    );

    const responses = decisions.filter(isApprovalResponse);
    assert.deepEqual(
      responses.map((command) =>
        command.type === "thread.approval.respond" ? command.requestId : "",
      ),
      ["req-after"],
    );

    const escalation = decisions.find(
      (command) =>
        isVerdictActivity(command) &&
        command.type === "thread.activity.append" &&
        (command.activity.payload as { verdict?: string }).verdict === "escalate",
    );
    assert.ok(escalation, "the escalation should be recorded as an activity");
  }),
);

it.effect("escalates when the supervisor model cannot be reached", () =>
  Effect.gen(function* () {
    const { decisions } = yield* withSupervisor({ verdict: () => "fail" }, (harness) =>
      Effect.gen(function* () {
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-model-down",
            requestType: "command_execution_approval",
            detail: "pnpm test",
          }),
        );
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-after",
            requestType: "file_read_approval",
            detail: "read src/a.ts",
          }),
        );
        yield* harness.awaitDispatch(
          (command) => isApprovalResponse(command) && command.requestId === "req-after",
        );
        return { decisions: yield* Ref.get(harness.dispatched) };
      }),
    );

    // A supervisor that cannot be reached has not approved anything.
    const responses = decisions.filter(isApprovalResponse);
    assert.equal(responses.length, 1);
  }),
);

it.effect("records every verdict as an activity with its reasoning", () =>
  Effect.gen(function* () {
    // ADR-0007 makes visibility the control, so "why did the agent do that"
    // has to stay answerable.
    const { decisions } = yield* withSupervisor(
      { verdict: () => ({ verdict: "approve", reasoning: "tests are routine" }) },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.emit(
            approvalRequestedEvent({
              requestId: "req-cmd",
              requestType: "command_execution_approval",
              detail: "pnpm test",
            }),
          );
          yield* harness.awaitDispatch(isApprovalResponse);
          return { decisions: yield* Ref.get(harness.dispatched) };
        }),
    );

    const verdict = decisions.find(isVerdictActivity);
    assert.ok(verdict && verdict.type === "thread.activity.append");
    assert.deepEqual(verdict.activity.payload, {
      requestId: "req-cmd",
      requestType: "command_execution_approval",
      verdict: "approve",
      reasoning: "tests are routine",
      consultedModel: true,
    });
  }),
);

it.effect("answers a redelivered request only once", () =>
  Effect.gen(function* () {
    // The engine republishes persisted events after a dispatch failure, so the
    // same approval can arrive twice.
    const { decisions, modelCalls } = yield* withSupervisor({}, (harness) =>
      Effect.gen(function* () {
        const event = approvalRequestedEvent({
          requestId: "req-dup",
          requestType: "command_execution_approval",
          detail: "pnpm test",
        });
        yield* harness.emit(event);
        yield* harness.emit(event);
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-after",
            requestType: "file_read_approval",
            detail: "read src/a.ts",
          }),
        );
        yield* harness.awaitDispatch(
          (command) => isApprovalResponse(command) && command.requestId === "req-after",
        );
        return {
          decisions: yield* Ref.get(harness.dispatched),
          modelCalls: yield* Ref.get(harness.modelCalls),
        };
      }),
    );

    assert.equal(modelCalls.length, 1);
    assert.equal(decisions.filter(isApprovalResponse).length, 2);
  }),
);

it.effect("escalates a request whose payload will not decode", () =>
  Effect.gen(function* () {
    const { decisions, modelCalls } = yield* withSupervisor({}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emit(
          approvalRequestedEvent({ requestId: "ignored", payloadOverride: { nonsense: true } }),
        );
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-after",
            requestType: "file_read_approval",
            detail: "read src/a.ts",
          }),
        );
        yield* harness.awaitDispatch(
          (command) => isApprovalResponse(command) && command.requestId === "req-after",
        );
        return {
          decisions: yield* Ref.get(harness.dispatched),
          modelCalls: yield* Ref.get(harness.modelCalls),
        };
      }),
    );

    assert.equal(modelCalls.length, 0);
    assert.equal(decisions.filter(isApprovalResponse).length, 1);
  }),
);

it.effect("ignores approvals on other threads", () =>
  Effect.gen(function* () {
    const { decisions } = yield* withSupervisor({}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-elsewhere",
            requestType: "file_read_approval",
            detail: "read src/a.ts",
            threadId: ThreadId.make("someone-elses-thread"),
          }),
        );
        yield* harness.emit(
          approvalRequestedEvent({
            requestId: "req-after",
            requestType: "file_read_approval",
            detail: "read src/a.ts",
          }),
        );
        yield* harness.awaitDispatch(
          (command) => isApprovalResponse(command) && command.requestId === "req-after",
        );
        return { decisions: yield* Ref.get(harness.dispatched) };
      }),
    );

    const responses = decisions.filter(isApprovalResponse);
    assert.deepEqual(
      responses.map((command) =>
        command.type === "thread.approval.respond" ? command.requestId : "",
      ),
      ["req-after"],
    );
  }),
);
