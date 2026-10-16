import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import * as Deferred from "effect/Deferred";
import {
  WorkflowActions,
  WorkflowActionError,
  changeWorkflowAction,
  type WorkflowActionIO,
} from "./WorkflowActions.ts";
import {
  type WorkflowOrigin,
  EnvironmentAuthorizationError,
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  EventId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { WorkflowControlResult, type RepositoryWorkflow } from "@t3tools/contracts/workflows";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Store from "./WorkflowRunStore.ts";
import { type WorkflowRequest } from "./RepositoryWorkflowRunner.ts";
import { decidePromptQueueCommand } from "../orchestration/promptQueueDecider.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";

import {
  NOW,
  MODEL,
  PROJECT,
  workflow,
  request,
  control,
  retryRequest,
  retryCancellation,
  completed,
  persistence,
  harness,
  test,
} from "./RepositoryWorkflowRunner.test-fixture.ts";
const recoverDelivery = Effect.fn(function* (h: Effect.Success<typeof harness>) {
  yield* h.complete;
  let current = (yield* Ref.get(h.currentThread))!;
  const apply = Effect.fn(function* (command: Parameters<typeof decidePromptQueueCommand>[1]) {
    const planned = yield* decidePromptQueueCommand(current, command, false);
    let state: OrchestrationReadModel = { ...createEmptyReadModel(NOW), threads: [current] };
    for (const event of planned)
      state = yield* projectEvent(state, { ...event, sequence: state.snapshotSequence + 1 });
    current = state.threads[0]!;
  });
  const queued = (yield* h.starts)[0]!;
  yield* apply({ ...queued, commandId: CommandId.make("queue-fixture"), threadId: current.id });
  current = {
    ...current,
    promptQueue: {
      ...current.promptQueue!,
      preparation: { ...current.promptQueue!.preparation!, state: "ready", settled: true },
      awaitingTurnId: null,
      admissions: [],
    },
  };
  yield* apply({
    type: "thread.prompt.claim",
    commandId: CommandId.make("uncertain-handoff"),
    threadId: current.id,
    messageId: MessageId.make("workflow:job-1:prompt"),
    expectedRevision: current.promptQueue!.entries[0]!.revision,
    expectedControlRevision: current.promptQueue!.revision,
    createdAt: NOW,
  });
  yield* apply({
    type: "thread.prompt.unknown",
    commandId: CommandId.make("restart-unknown"),
    threadId: current.id,
    attemptId: CommandId.make("uncertain-handoff"),
    detail: "Server restarted during delivery",
    createdAt: NOW,
  });
  current = { ...current, session: { ...current.session!, status: "stopped" } };
  yield* Ref.set(h.currentThread, current);
});

it.effect("durably cancels before acceptance and refuses a delayed Start after restart", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const scope = yield* Scope.make();
      const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
      assert.strictEqual((yield* runner.handle(control("cancel"))).outcome, "cancelled");
      yield* Scope.close(scope, Exit.void);
      const recovered = yield* h.newRunner;
      assert.strictEqual((yield* recovered.handle(request())).outcome, "cancelled");
      assert.strictEqual((yield* recovered.handle(control("status"))).outcome, "cancelled");
      assert.strictEqual((yield* h.starts).length, 0);
      assert.isNull(yield* (yield* Store.WorkflowRunStore).get("job-1"));
      assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
      const mismatch = {
        ...control("cancel"),
        control: { ...control("cancel").control, repositoryId: "another-repo" },
      };
      assert.strictEqual((yield* recovered.handle(mismatch)).outcome, "conflict");
      assert.strictEqual((yield* recovered.handle(request())).outcome, "cancelled");
    }),
  ),
);

it.effect("retries a confirmed stop failure once and ignores old failure evidence", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.complete;
      yield* Ref.update(h.currentThread, (current) => ({
        ...current!,
        session: { ...current!.session!, status: "running" as const },
      }));
      const initial = (yield* runner.handle(control("cancel"))).progress!;
      const stop = (yield* Ref.get(h.commands)).find(
        (command) => command.type === "thread.session.stop",
      )!;
      yield* Ref.update(h.currentThread, (current) => ({
        ...current!,
        activities: [
          ...current!.activities,
          {
            id: EventId.make("failed-stop"),
            kind: "provider.session.stop.failed",
            tone: "error" as const,
            summary: "Stop failed",
            turnId: null,
            createdAt: NOW,
            payload: { stopCommandId: stop.commandId, detail: "Provider could not stop" },
          },
        ],
      }));
      const failed = (yield* runner.handle(control("status"))).progress!;
      assert.isTrue(failed.retryableCancellation);
      assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
      assert.strictEqual(
        (yield* runner.handle(retryCancellation(initial.revision))).outcome,
        "conflict",
      );
      const response = retryCancellation(failed.revision);
      const retry = (yield* runner.handle(response)).progress!;
      assert.isFalse(retry.retryableCancellation);
      yield* runner.handle(response);
      yield* runner.handle(control("status"));
      const stops = (yield* Ref.get(h.commands)).filter(
        (command) => command.type === "thread.session.stop",
      );
      assert.strictEqual(stops.length, 2);
      assert.notStrictEqual(stops[0]!.commandId, stops[1]!.commandId);
      yield* Ref.update(h.currentThread, (current) => ({
        ...current!,
        session: { ...current!.session!, status: "stopped" as const },
      }));
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
    }),
  ),
);

it.effect(
  "offers an explicit cancellation retry after an accepted stop loses its worker on restart",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* runner.handle(request());
        yield* runner.handle(control("cancel"));
        yield* Scope.close(scope, Exit.void);
        const recovered = yield* h.newRunner;
        const progress = (yield* recovered.handle(control("status"))).progress!;
        assert.isTrue(progress.retryableCancellation);
        assert.include(progress.detail!, "restart");
        assert.strictEqual(
          (yield* Ref.get(h.commands)).filter((command) => command.type === "thread.session.stop")
            .length,
          1,
        );
        yield* recovered.handle(retryCancellation(progress.revision));
        assert.strictEqual(
          (yield* Ref.get(h.commands)).filter((command) => command.type === "thread.session.stop")
            .length,
          2,
        );
      }),
    ),
);

it.effect(
  "dismisses a recovered delivery handoff after stopping without another provider delivery",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* recoverDelivery(h);
        assert.isNotNull((yield* Ref.get(h.currentThread))!.promptQueue!.handoff);
        assert.strictEqual((yield* runner.handle(control("cancel"))).progress?.status, "cancelled");
        const savedThread = (yield* Ref.get(h.currentThread))!;
        assert.isNull(savedThread.promptQueue!.handoff);
        assert.isNull(savedThread.promptQueue!.awaitingTurnId);
        assert.isFalse(savedThread.promptQueue!.enabled);
        assert.strictEqual((yield* h.starts).length, 1);
        assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
      }),
    ),
);

for (const boundary of ["before_dismiss", "after_dismiss"] as const) {
  it.effect(`recovers queue dismissal ${boundary} without repeating delivery or dismissal`, () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* runner.handle(request());
        yield* recoverDelivery(h);
        yield* Ref.set(h.dismissalMode, boundary);
        yield* runner.handle(control("cancel")).pipe(Effect.flip);
        const store = yield* Store.WorkflowRunStore;
        const saved = (yield* store.get("job-1"))!;
        assert.isNotNull(saved.pendingQueueDismissal);
        assert.isTrue(yield* store.isExecuting());
        yield* Scope.close(scope, Exit.void);
        yield* Ref.set(h.dismissalMode, "normal");
        const recovered = yield* h.newRunner;
        assert.strictEqual(
          (yield* recovered.handle(control("status"))).progress?.status,
          "cancelled",
        );
        const dismissals = (yield* Ref.get(h.commands)).filter(
          (command) => command.type === "thread.queue.resolve",
        );
        assert.strictEqual(dismissals.length, 1);
        assert.strictEqual(dismissals[0]!.commandId, saved.pendingQueueDismissal!.commandId);
        assert.strictEqual((yield* h.starts).length, 1);
        assert.isFalse(yield* store.isExecuting());
        assert.isNull((yield* store.get("job-1"))!.pendingQueueDismissal);
      }),
    ),
  );
}

it.effect("rechecks a changed queue revision before dismissing recovered delivery", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* recoverDelivery(h);
      yield* Ref.set(h.dismissalMode, "change_revision");
      const pending = (yield* runner.handle(control("cancel"))).progress!;
      assert.strictEqual(pending.status, "cancelling");
      assert.isFalse(pending.retryableCancellation);
      assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      const dismissals = (yield* Ref.get(h.commands)).filter(
        (command) => command.type === "thread.queue.resolve",
      );
      assert.strictEqual(dismissals.length, 2);
      assert.notStrictEqual(dismissals[0]!.commandId, dismissals[1]!.commandId);
      assert.strictEqual((yield* h.starts).length, 1);
      assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
    }),
  ),
);

it.effect("requires explicit retry after dismissal rejection at the same queue revision", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* recoverDelivery(h);
      yield* Ref.set(h.dismissalMode, "reject_dismiss");
      const rejected = (yield* runner.handle(control("cancel"))).progress!;
      assert.isTrue(rejected.retryableCancellation);
      yield* Ref.set(h.dismissalMode, "normal");
      yield* runner.handle(control("status"));
      yield* runner.handle(control("cancel"));
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((command) => command.type === "thread.queue.resolve")
          .length,
        1,
      );
      assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
      assert.strictEqual(
        (yield* runner.handle(retryCancellation(rejected.revision))).progress?.status,
        "cancelled",
      );
      const dismissals = (yield* Ref.get(h.commands)).filter(
        (command) => command.type === "thread.queue.resolve",
      );
      assert.strictEqual(dismissals.length, 2);
      assert.notStrictEqual(dismissals[0]!.commandId, dismissals[1]!.commandId);
      assert.strictEqual((yield* h.starts).length, 1);
    }),
  ),
);

it.effect(
  "does not dismiss uncertain delivery while provider or setup stopping is unconfirmed",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* recoverDelivery(h);
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          session: { ...current!.session!, status: "running" as const },
        }));
        assert.strictEqual(
          (yield* runner.handle(control("cancel"))).progress?.status,
          "cancelling",
        );
        assert.isFalse(
          (yield* Ref.get(h.commands)).some((command) => command.type === "thread.queue.resolve"),
        );
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          session: { ...current!.session!, status: "stopped" as const },
          promptQueue: {
            ...current!.promptQueue!,
            preparation: {
              ...current!.promptQueue!.preparation!,
              state: "failed" as const,
              settled: false,
            },
          },
        }));
        assert.strictEqual(
          (yield* runner.handle(control("status"))).progress?.status,
          "cancelling",
        );
        assert.isFalse(
          (yield* Ref.get(h.commands)).some((command) => command.type === "thread.queue.resolve"),
        );
        assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          promptQueue: {
            ...current!.promptQueue!,
            preparation: { ...current!.promptQueue!.preparation!, settled: true },
          },
        }));
        assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
        assert.strictEqual((yield* h.starts).length, 1);
        assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
      }),
    ),
);

it.effect("atomically chooses acceptance or a cancellation fence and preserves accepted runs", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const accepted = (yield* store.get("job-1"))!;
      const [acceptance, cancellation] = yield* Effect.all(
        [
          store.tryAccept({
            ...accepted,
            jobId: "raced-job",
            executionReserved: false,
            progress: { ...accepted.progress, threadId: ThreadId.make("workflow:raced-job:agent") },
          }),
          store.cancelBeforeAcceptance({
            jobId: "raced-job",
            organizationId: "org-1",
            repositoryId: "repo-1",
            projectId: PROJECT,
            repositoryCanonicalKey: request().repositoryCanonicalKey,
            createdAt: NOW,
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(acceptance, cancellation.run !== null);
      assert.strictEqual(acceptance, cancellation.cancellation === null);
      assert.strictEqual((yield* store.get("raced-job")) !== null, acceptance);
      assert.strictEqual((yield* store.getCancellation("raced-job")) === null, acceptance);
      const existing = yield* store.cancelBeforeAcceptance({
        jobId: "job-1",
        organizationId: "org-1",
        repositoryId: "repo-1",
        projectId: PROJECT,
        repositoryCanonicalKey: request().repositoryCanonicalKey,
        createdAt: NOW,
      });
      assert.isNotNull(existing.run);
      assert.isNull(existing.cancellation);
    }),
  ),
);

it.effect(
  "consults with the frozen job context in the worktree prepared after supervisor attachment",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        const current = (yield* Ref.get(h.currentThread))!;
        yield* Ref.set(h.currentThread, { ...current, worktreePath: "/jobs/job-1" });
        const event: OrchestrationEvent = {
          type: "thread.activity-appended",
          sequence: 1,
          eventId: EventId.make("approval-event"),
          aggregateKind: "thread",
          aggregateId: current.id,
          occurredAt: NOW,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: current.id,
            activity: {
              id: EventId.make("approval"),
              kind: "approval.requested",
              tone: "approval",
              summary: "Run tests",
              turnId: null,
              createdAt: NOW,
              payload: {
                requestId: "approval-1",
                requestType: "command_execution_approval",
                detail: "pnpm test",
              },
            },
          },
        };
        yield* h.emit(event);
        const consultation = yield* Queue.take(h.modelCalls);
        assert.strictEqual(consultation.cwd, "/jobs/job-1");
        assert.strictEqual(
          consultation.stepInstruction,
          workflow.definition.steps.find((step) => step.kind === "agent")!.instruction,
        );
        assert.strictEqual(consultation.jobContext, request().instruction);
        assert.include(consultation.reviewConstraint!, "human review");
      }),
    ),
);

it.effect("accepts a job once, bounds bursts, and freezes its definition", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      const first = yield* runner.handle(request());
      assert.strictEqual(first.progress?.status, "preparing");
      const changed = {
        ...request(),
        control: {
          ...request().control,
          operation: "start" as const,
          workflow: {
            ...workflow,
            revision: 2,
            definition: { ...workflow.definition, name: "Edited after offer" },
          },
        },
      };
      yield* runner.handle(changed);
      const burst = yield* Effect.forEach(
        ["job-2", "job-3", "job-4"],
        (id) => runner.handle(request(id)),
        { concurrency: "unbounded" },
      );
      assert.isTrue(burst.every((result) => result.outcome === "busy"));
      assert.strictEqual((yield* h.starts).length, 1);
      assert.strictEqual(
        (yield* (yield* Store.WorkflowRunStore).get("job-1"))?.workflow.definition.name,
        workflow.definition.name,
      );
    }),
  ),
);

it.effect("recovers accepted work without another prompt and waits for a finalized result", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const scope = yield* Scope.make();
      const first = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
      yield* first.handle(request());
      yield* Scope.close(scope, Exit.void);
      const restarted = yield* h.newRunner;
      yield* h.complete;
      yield* Ref.update(h.currentThread, (value) => ({
        ...value!,
        promptQueue: { ...value!.promptQueue!, finalizedTurnId: null },
      }));
      assert.strictEqual((yield* restarted.handle(control("status"))).progress?.status, "running");
      yield* h.complete;
      assert.strictEqual(
        (yield* restarted.handle(control("status"))).progress?.status,
        "awaiting_review",
      );
      assert.strictEqual((yield* h.starts).length, 1);
    }),
  ),
);

it.effect(
  "requires the current checkpoint and unchanged files/head before idempotent approval",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        const review = (yield* runner.handle(control("status"))).progress!;
        const approve: WorkflowRequest = {
          ...request(),
          control: {
            operation: "approve",
            organizationId: "org-1",
            repositoryId: "repo-1",
            projectId: PROJECT,
            expectedRevision: review.revision,
            checkpointId: review.checkpoint!.checkpointId,
          },
        };
        const stale = {
          ...approve,
          control: {
            ...approve.control,
            operation: "approve" as const,
            expectedRevision: 0,
            checkpointId: "old",
          },
        };
        assert.strictEqual((yield* runner.handle(stale)).outcome, "conflict");
        yield* Ref.set(h.difference, "changed files");
        assert.strictEqual((yield* runner.handle(approve)).outcome, "conflict");
        yield* Ref.set(h.difference, "");
        yield* Ref.set(h.head, "changed-head");
        assert.strictEqual((yield* runner.handle(approve)).outcome, "conflict");
        yield* Ref.set(h.head, "base-sha");
        assert.strictEqual((yield* runner.handle(approve)).progress?.status, "done");
        assert.strictEqual((yield* runner.handle(approve)).progress?.status, "done");
        assert.strictEqual((yield* runner.handle(control("cancel"))).progress?.status, "done");
      }),
    ),
);

it.effect("keeps cancellation pending until setup and provider stop are acknowledged", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      assert.strictEqual((yield* runner.handle(control("cancel"))).progress?.status, "cancelling");
      yield* Ref.update(h.currentThread, (value) => ({
        ...value!,
        promptQueue: {
          ...value!.promptQueue!,
          preparation: {
            ...value!.promptQueue!.preparation!,
            state: "failed" as const,
            settled: false,
          },
        },
      }));
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelling");
      yield* Ref.update(h.currentThread, (value) => ({
        ...value!,
        promptQueue: {
          ...value!.promptQueue!,
          preparation: { ...value!.promptQueue!.preparation!, settled: true },
        },
      }));
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      yield* h.complete;
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      assert.strictEqual((yield* h.starts).length, 1);
    }),
  ),
);

it.effect(
  "pauses failed preparation, retries explicitly, and protects the owned thread/worktree",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* Ref.update(h.currentThread, (value) => ({
          ...value!,
          worktreePath: "/jobs/job-1",
          promptQueue: {
            ...value!.promptQueue!,
            preparation: {
              ...value!.promptQueue!.preparation!,
              state: "failed" as const,
              settled: true,
              failure: { reason: "interrupted" as const, detail: "Setup was interrupted" },
            },
          },
        }));
        const paused = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(paused.status, "paused");
        const store = yield* Store.WorkflowRunStore;
        assert.isTrue(
          Option.isSome(
            yield* store
              .requireCommand({
                type: "thread.session.stop",
                commandId: CommandId.make("external-stop"),
                threadId: ThreadId.make("workflow:job-1:agent"),
                createdAt: NOW,
              })
              .pipe(Effect.flip, Effect.option),
          ),
        );
        assert.isTrue(
          Option.isSome(
            yield* store.requireWorkspace("/jobs/job-1").pipe(Effect.flip, Effect.option),
          ),
        );
        assert.strictEqual(
          (yield* runner.handle(retryRequest(paused.revision))).progress?.status,
          "preparing",
        );
        assert.strictEqual((yield* h.starts).length, 1);
        assert.strictEqual(
          (yield* Ref.get(h.commands)).filter(
            (command) => command.type === "thread.preparation.retry",
          ).length,
          1,
        );
      }),
    ),
);

for (const boundary of ["before_retry", "after_retry"] as const) {
  it.effect(`recovers preparation retry ${boundary} without duplicate delivery`, () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* runner.handle(request());
        yield* h.failPreparation;
        const paused = (yield* runner.handle(control("status"))).progress!;
        yield* Ref.set(h.retryMode, boundary);
        yield* runner.handle(retryRequest(paused.revision)).pipe(Effect.flip);
        const store = yield* Store.WorkflowRunStore;
        const saved = (yield* store.get("job-1"))!;
        assert.strictEqual(saved.progress.status, "preparing");
        assert.isNotNull(saved.pendingPreparationRetry);
        assert.isTrue(yield* store.isExecuting());
        yield* Scope.close(scope, Exit.void);
        yield* Ref.set(h.retryMode, "normal");
        if (boundary === "after_retry") yield* h.complete;
        const restarted = yield* h.newRunner;
        const recovered = (yield* restarted.handle(control("status"))).progress!;
        assert.strictEqual(
          recovered.status,
          boundary === "after_retry" ? "awaiting_review" : "preparing",
        );
        assert.isNull((yield* store.get("job-1"))!.pendingPreparationRetry);
        const retries = (yield* Ref.get(h.commands)).filter(
          (cmd) => cmd.type === "thread.preparation.retry",
        );
        assert.strictEqual(retries.length, 1);
        assert.strictEqual(retries[0]!.commandId, saved.pendingPreparationRetry!.commandId);
        assert.strictEqual((yield* h.starts).length, 1);
        if (boundary === "after_retry") assert.isFalse(yield* store.isExecuting());
      }),
    ),
  );
}

it.effect("uses a fresh retry identity after durable rejection", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.failPreparation;
      const paused = (yield* runner.handle(control("status"))).progress!;
      yield* Ref.set(h.retryMode, "reject_retry");
      const rejected = (yield* runner.handle(retryRequest(paused.revision))).progress!;
      assert.strictEqual(rejected.status, "paused");
      assert.include(rejected.detail!, "Preparation changed");
      assert.isTrue(rejected.retryablePreparation);
      assert.isNull((yield* (yield* Store.WorkflowRunStore).get("job-1"))!.pendingPreparationRetry);
      yield* Ref.set(h.retryMode, "normal");
      assert.strictEqual(
        (yield* runner.handle(retryRequest(rejected.revision))).progress?.status,
        "preparing",
      );
      const retries = (yield* Ref.get(h.commands)).filter(
        (cmd) => cmd.type === "thread.preparation.retry",
      );
      assert.strictEqual(retries.length, 2);
      assert.notStrictEqual(retries[0]!.commandId, retries[1]!.commandId);
    }),
  ),
);

it.effect("fences redelivered retry after the accepted preparation fails again", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.failPreparation;
      const paused = (yield* runner.handle(control("status"))).progress!;
      const response = retryRequest(paused.revision);
      yield* Ref.set(h.retryMode, "after_retry");
      yield* runner.handle(response).pipe(Effect.flip);
      yield* h.failPreparation;
      yield* Ref.set(h.retryMode, "normal");
      const repeated = yield* runner.handle(response);
      assert.strictEqual(repeated.outcome, "conflict");
      assert.strictEqual(repeated.progress?.status, "paused");
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((cmd) => cmd.type === "thread.preparation.retry")
          .length,
        1,
      );
      assert.strictEqual(
        (yield* runner.handle(retryRequest(repeated.progress!.revision))).progress?.status,
        "preparing",
      );
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((cmd) => cmd.type === "thread.preparation.retry")
          .length,
        2,
      );
    }),
  ),
);

it.effect("cancels an undispatched retry before reconciliation can deliver it", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.failPreparation;
      const paused = (yield* runner.handle(control("status"))).progress!;
      yield* Ref.set(h.retryMode, "before_retry");
      yield* runner.handle(retryRequest(paused.revision)).pipe(Effect.flip);
      yield* Ref.set(h.retryMode, "normal");
      assert.strictEqual((yield* runner.handle(control("cancel"))).progress?.status, "cancelled");
      const store = yield* Store.WorkflowRunStore;
      assert.isNull((yield* store.get("job-1"))!.pendingPreparationRetry);
      assert.isFalse(yield* store.isExecuting());
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((cmd) => cmd.type === "thread.preparation.retry")
          .length,
        0,
      );
      assert.strictEqual((yield* runner.handle(request("job-2"))).outcome, "accepted");
    }),
  ),
);

it.effect("keeps cancellation reserved until an accepted retry acknowledges setup settlement", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.failPreparation;
      const paused = (yield* runner.handle(control("status"))).progress!;
      yield* Ref.set(h.retryMode, "after_retry");
      yield* runner.handle(retryRequest(paused.revision)).pipe(Effect.flip);
      const store = yield* Store.WorkflowRunStore;
      const cancelling = yield* runner.handle(control("cancel"));
      assert.strictEqual(cancelling.progress?.status, "cancelling");
      assert.strictEqual(
        (yield* runner.handle(control("cancel"))).progress?.revision,
        cancelling.progress!.revision,
      );
      assert.isTrue(yield* store.isExecuting());
      assert.isNull((yield* store.get("job-1"))!.pendingPreparationRetry);
      yield* Ref.update(h.currentThread, (value) => ({
        ...value!,
        promptQueue: {
          ...value!.promptQueue!,
          preparation: {
            ...value!.promptQueue!.preparation!,
            state: "failed" as const,
            settled: true,
          },
        },
      }));
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      assert.isFalse(yield* store.isExecuting());
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((cmd) => cmd.type === "thread.preparation.retry")
          .length,
        1,
      );
      assert.strictEqual((yield* runner.handle(retryRequest(paused.revision))).outcome, "conflict");
    }),
  ),
);

it.effect(
  "releases automatic capacity at review and rejects aliased workspace/thread creation",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        assert.strictEqual(
          (yield* runner.handle(control("status"))).progress?.status,
          "awaiting_review",
        );
        const store = yield* Store.WorkflowRunStore;
        assert.isFalse(yield* store.isExecuting());
        assert.isTrue(
          Option.isSome(
            yield* store
              .requireWorkspace("/jobs/job-1/../job-1/subdir")
              .pipe(Effect.flip, Effect.option),
          ),
        );
        const create: OrchestrationCommand = {
          type: "thread.create",
          commandId: CommandId.make("external-create"),
          threadId: ThreadId.make("other-thread"),
          projectId: PROJECT,
          title: "Bypass",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "t3-job/job-1",
          worktreePath: "/jobs/job-1",
          createdAt: NOW,
        };
        assert.isTrue(
          Option.isSome(yield* store.requireCommand(create).pipe(Effect.flip, Effect.option)),
        );
        assert.strictEqual(
          (yield* runner.handle(control("cancel"))).progress?.status,
          "cancelling",
        );
        assert.isFalse(yield* store.isExecuting());
        assert.strictEqual((yield* runner.handle(request("job-2"))).outcome, "accepted");
      }),
    ),
);

it.effect("recovers a persisted cancellation intent before its stop command was sent", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const first = yield* h.newRunner;
      yield* first.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const saved = (yield* store.get("job-1"))!;
      yield* store.save({ ...saved, progress: { ...saved.progress, status: "cancelling" } });
      const recovered = yield* h.newRunner;
      yield* recovered.handle(control("status"));
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((command) => command.type === "thread.session.stop")
          .length,
        1,
      );
      assert.strictEqual((yield* h.starts).length, 1);
    }),
  ),
);

it.effect("cancels a reserved job before its thread was created without dispatching work", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const saved = (yield* store.get("job-1"))!;
      yield* store.save({ ...saved, promptDispatched: false });
      yield* Ref.set(h.currentThread, null);
      const count = (yield* Ref.get(h.commands)).length;
      const cancelled = yield* runner.handle(control("cancel"));
      assert.strictEqual(cancelled.progress?.status, "cancelled");
      assert.include(cancelled.progress!.detail!, "before the agent started");
      assert.isFalse(yield* store.isExecuting());
      assert.strictEqual((yield* Ref.get(h.commands)).length, count);
    }),
  ),
);

it.effect("persists one execution reservation per environment and frees it at review", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const first = (yield* store.get("job-1"))!;
      const another = {
        ...first,
        jobId: "job-reservation",
        progress: { ...first.progress, threadId: ThreadId.make("workflow:job-reservation:agent") },
      };
      assert.isFalse(yield* store.tryAccept(another));
      const otherEnvironment = {
        ...another,
        jobId: "other-env-job",
        progress: { ...another.progress, threadId: ThreadId.make("workflow:other-env-job:agent") },
        workflow: {
          ...another.workflow,
          definition: {
            ...another.workflow.definition,
            environmentId: EnvironmentId.make("env-2"),
          },
        },
      };
      assert.isTrue(yield* store.tryAccept(otherEnvironment));
      yield* h.complete;
      yield* runner.handle(control("status"));
      assert.isTrue(yield* store.tryAccept(another));
      assert.isFalse(yield* store.tryAccept(another));
    }),
  ),
);

it.effect(
  "refuses unsupported/disabled providers and a checkout whose repository changed before acceptance",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        const provider = (yield* Ref.get(h.providers))[0]!;
        for (const driver of ["cursor", "grok", "opencode", "antigravity"]) {
          yield* Ref.set(h.providers, [{ ...provider, driver: ProviderDriverKind.make(driver) }]);
          assert.strictEqual((yield* runner.handle(request())).outcome, "unavailable");
        }
        yield* Ref.set(h.providers, [{ ...provider, enabled: false }]);
        assert.strictEqual((yield* runner.handle(request())).outcome, "unavailable");
        yield* Ref.set(h.providers, [provider]);
        yield* Ref.set(h.repositoryKey, "github.com/acme/different-repo");
        assert.strictEqual((yield* runner.handle(request())).outcome, "unavailable");
        assert.isNull(yield* (yield* Store.WorkflowRunStore).get("job-1"));
        assert.strictEqual((yield* h.starts).length, 0);
      }),
    ),
);

it.effect("keeps individual approval responses available while refusing session-wide trust", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const approval: OrchestrationCommand = {
        type: "thread.approval.respond",
        commandId: CommandId.make("external-trust"),
        threadId: ThreadId.make("workflow:job-1:agent"),
        requestId: ApprovalRequestId.make("request-1"),
        decision: "acceptAlways",
        createdAt: NOW,
      };
      assert.isTrue(
        Option.isSome(yield* store.requireCommand(approval).pipe(Effect.flip, Effect.option)),
      );
      yield* store.requireCommand({ ...approval, decision: "decline" });
    }),
  ),
);

const approve = (progress: Store.WorkflowRun["progress"]): WorkflowRequest => ({
  ...request(),
  control: {
    operation: "approve",
    organizationId: "org-1",
    repositoryId: "repo-1",
    projectId: PROJECT,
    expectedRevision: progress.revision,
    checkpointId: progress.checkpoint!.checkpointId,
  },
});
const backgroundScript = {
  id: "preview",
  name: "Preview",
  command: "preview",
  async: true,
};
const withBackground = (h: Effect.Success<typeof harness>, settled = false) =>
  Ref.update(h.currentThread, (current) => ({
    ...current!,
    promptQueue: {
      ...current!.promptQueue!,
      preparation: {
        ...current!.promptQueue!.preparation!,
        script: backgroundScript,
        settled,
      },
    },
  }));

it.effect.each(["approve", "changed", "cancel"] as const)(
  "review retains the preview and ownership until cleanup: %s",
  (action) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        yield* withBackground(h);
        const review = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(review.status, "awaiting_review");
        const store = yield* Store.WorkflowRunStore;
        assert.isFalse(yield* store.isExecuting());
        assert.isNotNull(yield* store.getByThread(review.threadId));
        const response = approve(review);
        const pending = (yield* runner.handle(response)).progress!;
        assert.isTrue(pending.approvalPending);
        const approvalId = yield* Queue.take(h.cleanups);
        yield* runner.handle(response);
        yield* runner.handle(control("status"));
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        assert.isNotNull(yield* store.getByThread(review.threadId));
        if (action === "changed") yield* Ref.set(h.difference, "changed during cleanup");
        if (action === "cancel") {
          yield* Ref.update(h.currentThread, (current) => ({
            ...current!,
            session: { ...current!.session!, status: "stopped" as const },
            promptQueue: {
              ...current!.promptQueue!,
              preparation: {
                ...current!.promptQueue!.preparation!,
                state: "failed" as const,
                settled: true,
              },
            },
          }));
          assert.strictEqual(
            (yield* runner.handle(control("cancel"))).progress?.status,
            "cancelling",
          );
          const cancelId = yield* Queue.take(h.cleanups);
          assert.notStrictEqual(approvalId, cancelId);
          yield* Queue.offer(h.cleanupOutcomes, null);
          yield* Queue.offer(h.cleanupOutcomes, null);
          const cancelled = yield* h.awaitRun((run) => run.progress.status === "cancelled");
          assert.isNull(cancelled.approvalAttempt);
          assert.isNull(cancelled.approvedBy);
          assert.isNull(yield* store.getByThread(review.threadId));
        } else {
          yield* Queue.offer(h.cleanupOutcomes, null);
          const finished = yield* h.awaitRun(
            (run) =>
              run.progress.approvalPending === false && run.progress.revision > pending.revision,
          );
          assert.strictEqual(
            finished.progress.status,
            action === "changed" ? "awaiting_review" : "done",
          );
          assert.strictEqual(finished.approvedBy, action === "changed" ? null : "user-1");
          assert.strictEqual(
            (yield* store.getByThread(review.threadId)) !== null,
            action === "changed",
          );
          if (action === "changed") assert.include(finished.progress.detail!, "files changed");
        }
      }),
    ),
);
it.effect(
  "approval cleanup failure requires an explicit retry and retains the first approver",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        yield* withBackground(h, true);
        const review = (yield* runner.handle(control("status"))).progress!;
        const first = approve(review);
        yield* runner.handle(first);
        const firstId = yield* Queue.take(h.cleanups);
        yield* Queue.offer(h.cleanupOutcomes, "Termination denied");
        const failed = yield* h.awaitRun((run) => run.progress.retryableApproval === true);
        assert.strictEqual(failed.progress.status, "awaiting_review");
        assert.isFalse(failed.progress.approvalPending);
        yield* runner.handle(first);
        yield* runner.handle(control("status"));
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        const retry = { ...approve(failed.progress), userId: "another-maintainer" };
        yield* runner.handle(retry);
        assert.notStrictEqual(yield* Queue.take(h.cleanups), firstId);
        yield* Queue.offer(h.cleanupOutcomes, null);
        const done = yield* h.awaitRun((run) => run.progress.status === "done");
        assert.strictEqual(done.approvedBy, "user-1");
      }),
    ),
);
it.effect.each(["status", "restart"] as const)(
  "unknown delivery before admission stays visibly paused and never retries: %s",
  (boundary) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const first = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* first.handle(request());
        yield* h.complete;
        let current = (yield* Ref.get(h.currentThread))!;
        current = {
          ...current,
          latestTurn: null,
          checkpoints: [],
          session: null,
          promptQueue: {
            ...current.promptQueue!,
            admissions: [],
            finalizedTurnId: null,
            awaitingTurnId: null,
            preparation: { ...current.promptQueue!.preparation!, state: "ready", settled: true },
          },
        };
        const apply = Effect.fn(function* (
          command: Parameters<typeof decidePromptQueueCommand>[1],
        ) {
          const events = yield* decidePromptQueueCommand(current, command, false);
          let state: OrchestrationReadModel = { ...createEmptyReadModel(NOW), threads: [current] };
          for (const event of events)
            state = yield* projectEvent(state, { ...event, sequence: state.snapshotSequence + 1 });
          current = state.threads[0]!;
        });
        yield* apply({
          type: "thread.prompt.enqueue",
          threadId: current.id,
          commandId: CommandId.make("unknown-enqueue"),
          message: {
            messageId: MessageId.make("workflow:job-1:prompt"),
            text: "work",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: NOW,
        });
        yield* apply({
          type: "thread.prompt.claim",
          commandId: CommandId.make("claim-before-crash"),
          threadId: current.id,
          messageId: MessageId.make("workflow:job-1:prompt"),
          expectedRevision: current.promptQueue!.entries[0]!.revision,
          expectedControlRevision: current.promptQueue!.revision,
          createdAt: NOW,
        });
        yield* apply({
          type: "thread.prompt.unknown",
          commandId: CommandId.make("crashed-delivery"),
          threadId: current.id,
          attemptId: CommandId.make("claim-before-crash"),
          detail: "Lost delivery acknowledgement",
          createdAt: NOW,
        });
        current = {
          ...current,
          promptQueue: {
            ...current.promptQueue!,
            preparation: {
              ...current.promptQueue!.preparation!,
              state: "failed",
              settled: true,
              failure: { reason: "interrupted", detail: "Setup also failed" },
            },
          },
        };
        yield* Ref.set(h.currentThread, current);
        if (boundary === "restart") yield* Scope.close(scope, Exit.void);
        const runner = boundary === "restart" ? yield* h.newRunner : first;
        const paused = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(paused.status, "paused");
        assert.isFalse(paused.retryablePreparation);
        assert.include(paused.detail!, "delivery could not be confirmed");
        assert.strictEqual(
          (yield* runner.handle(control("status"))).progress?.revision,
          paused.revision,
        );
        assert.strictEqual(
          (yield* runner.handle(retryRequest(paused.revision))).outcome,
          "conflict",
        );
        assert.strictEqual((yield* h.starts).length, 1);
        assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
        assert.isNotNull(yield* (yield* Store.WorkflowRunStore).getByThread(current.id));
        assert.isNotNull((yield* Ref.get(h.currentThread))?.promptQueue?.handoff);
        const cancelled = (yield* runner.handle(control("cancel"))).progress!;
        assert.strictEqual(cancelled.status, "cancelled");
      }),
    ),
);

it.effect.each(["pending", "confirmed"] as const)(
  "recovers approval %s without changing the approved result",
  (boundary) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const first = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* first.handle(request());
        yield* h.complete;
        yield* withBackground(h);
        const review = (yield* first.handle(control("status"))).progress!;
        const response = approve(review);
        yield* first.handle(response);
        const commandId = yield* Queue.take(h.cleanups);
        yield* Scope.close(scope, Exit.void);
        const store = yield* Store.WorkflowRunStore;
        if (boundary === "confirmed") {
          yield* Ref.set(h.confirmedCleanup, true);
          const saved = (yield* store.get("job-1"))!;
          yield* store.save({
            ...saved,
            approvalAttempt: {
              ...saved.approvalAttempt!,
              setupCleanup: { ...saved.approvalAttempt!.setupCleanup!, state: "done" },
            },
          });
        }
        const recovered = yield* h.newRunner;
        const state = (yield* recovered.handle(response)).progress!;
        if (boundary === "pending") {
          assert.isTrue(state.approvalPending);
          assert.strictEqual(yield* Queue.take(h.cleanups), commandId);
          yield* Queue.offer(h.cleanupOutcomes, null);
          yield* h.awaitRun((run) => run.progress.status === "done");
        } else {
          assert.strictEqual(state.status, "done");
          assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        }
        const done = (yield* store.get("job-1"))!;
        assert.strictEqual(done.approvedBy, "user-1");
        assert.strictEqual(done.progress.checkpoint?.checkpointId, review.checkpoint?.checkpointId);
        assert.strictEqual((yield* h.starts).length, 1);
      }),
    ),
);

it.effect.each(["projection", "final-write", "race", "replacement"] as const)(
  "cleanup proof survives approval settlement recovery: %s",
  (boundary) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        yield* withBackground(h);
        const review = (yield* runner.handle(control("status"))).progress!;
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          promptQueue: {
            ...current!.promptQueue!,
            preparation: {
              ...current!.promptQueue!.preparation!,
              state: "failed" as const,
              settled: false,
              failure: { reason: "interrupted" as const, detail: "Setup failed before restart" },
            },
          },
        }));
        if (boundary === "projection") yield* Ref.set(h.settlementMode, "reject");
        if (boundary === "race") yield* Ref.set(h.settlementMode, "race");
        if (boundary === "final-write") yield* Ref.set(h.finalWriteFailures, 1);
        yield* runner.handle(approve(review));
        yield* Queue.take(h.cleanups);
        if (boundary === "replacement")
          yield* Ref.update(h.currentThread, (current) => ({
            ...current!,
            promptQueue: {
              ...current!.promptQueue!,
              preparation: {
                ...current!.promptQueue!.preparation!,
                attemptId: CommandId.make("replacement"),
              },
            },
          }));
        yield* Queue.offer(h.cleanupOutcomes, null);
        const finished = yield* h.awaitRun(
          (run) =>
            run.progress.approvalPending === false && run.progress.revision > review.revision + 1,
        );
        const preparation = (yield* Ref.get(h.currentThread))!.promptQueue!.preparation!;
        if (boundary === "replacement") {
          assert.strictEqual(finished.progress.status, "awaiting_review");
          assert.isFalse(finished.progress.retryableApproval);
          assert.isNull(finished.approvalAttempt);
          assert.isFalse(preparation.settled);
          assert.include(finished.progress.detail!, "Cancel the job");
          return;
        }
        if (boundary !== "race") {
          assert.isTrue(finished.progress.retryableApproval);
          assert.strictEqual(finished.progress.status, "awaiting_review");
          yield* Ref.set(h.settlementMode, "normal");
          const retried = yield* runner.handle({
            ...approve(finished.progress),
            userId: "another-maintainer",
          });
          assert.strictEqual(retried.progress?.status, "done");
        } else assert.strictEqual(finished.progress.status, "done");
        const done = (yield* (yield* Store.WorkflowRunStore).get("job-1"))!;
        assert.strictEqual(done.approvedBy, "user-1");
        const settled = (yield* Ref.get(h.currentThread))!.promptQueue!.preparation!;
        assert.strictEqual(settled.state, "failed");
        assert.isTrue(settled.settled);
        assert.strictEqual(settled.failure?.detail, "Setup failed before restart");
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        assert.strictEqual((yield* h.starts).length, 1);
      }),
    ),
);
it.effect(
  "a persistence outage retains accepted approval and reuses cleanup on reconciliation",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        yield* withBackground(h);
        const review = (yield* runner.handle(control("status"))).progress!;
        yield* runner.handle(approve(review));
        yield* Queue.take(h.cleanups);
        yield* Ref.set(h.finalWriteFailures, 2);
        yield* Queue.offer(h.cleanupOutcomes, null);
        yield* h.awaitRun((run) => run.approvalAttempt?.setupCleanup?.state === "done");
        // The serialized status call drains pending worker finalization before its own reconciliation.
        const result = yield* runner.handle(control("status"));
        assert.strictEqual(result.progress?.status, "done");
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        assert.isTrue((yield* Ref.get(h.currentThread))!.promptQueue!.preparation!.settled);
      }),
    ),
);

const multiWorkflow: RepositoryWorkflow = {
  ...workflow,
  definition: {
    ...workflow.definition,
    steps: [
      { id: "brief", kind: "input", title: "Brief", question: "What is the goal?", role: "member" },
      workflow.definition.steps[0]!,
      workflow.definition.steps[1]!,
      {
        id: "details",
        kind: "input",
        title: "Details",
        question: "Any extra requirements?",
        role: "member",
      },
      {
        id: "verify",
        kind: "agent",
        title: "Verify",
        instruction: "Verify the updated result",
        modelSelection: null,
      },
      {
        id: "final-review",
        kind: "review",
        title: "Final review",
        role: "maintainer",
        reworkStepId: "agent",
      },
    ],
  },
};
const multiRequest = () => ({
  ...request(),
  control: { ...request().control, operation: "start" as const, workflow: multiWorkflow },
});
function checkpointResponse(
  progress: NonNullable<import("@t3tools/contracts/workflows").WorkflowControlResult["progress"]>,
  operation: "input" | "request_changes",
  text: string,
): WorkflowRequest {
  return {
    ...request(),
    control: {
      ...control("status").control,
      operation,
      checkpointId: progress.checkpoint!.checkpointId,
      expectedRevision: progress.revision,
      text,
    },
  };
}
it.effect(
  "runs multiple human checkpoints, reuses setup, and reworks only the selected suffix",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        let runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        const input = (yield* runner.handle(multiRequest())).progress!;
        assert.strictEqual(input.status, "awaiting_input");
        assert.isFalse(input.hasThread);
        assert.lengthOf(yield* h.starts, 0);
        const initialAnswer = checkpointResponse(input, "input", "Keep the prefix goal");
        yield* runner.handle(initialAnswer);
        assert.strictEqual((yield* h.starts)[0]!.bootstrap!.runSetupScript, true);
        yield* h.completeCurrent;
        yield* withBackground(h);
        const review = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(review.status, "awaiting_review");
        const detail = (yield* runner.handle(approve(review))).progress!;
        assert.strictEqual(detail.status, "awaiting_input");
        assert.lengthOf(yield* h.starts, 1);
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        assert.isFalse((yield* Ref.get(h.currentThread))!.promptQueue!.preparation!.settled);
        yield* Scope.close(scope, Exit.void);
        runner = yield* h.newRunner;
        const restored = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(restored.checkpoint!.checkpointId, detail.checkpoint!.checkpointId);
        yield* runner.handle(checkpointResponse(restored, "input", "Suffix requirement"));
        const second = (yield* h.starts)[1]!;
        assert.isUndefined(second.bootstrap);
        assert.include(second.message.text, "Keep the prefix goal");
        assert.include(second.message.text, "Suffix requirement");
        assert.strictEqual(second.threadId, review.threadId);
        yield* h.completeCurrent;
        const finalReview = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(finalReview.checkpoint!.stepId, "final-review");
        yield* runner.handle(
          checkpointResponse(finalReview, "request_changes", "Please revise implementation"),
        );
        const rework = (yield* h.starts)[2]!;
        assert.isUndefined(rework.bootstrap);
        assert.strictEqual(rework.threadId, second.threadId);
        assert.include(rework.message.text, "Please revise implementation");
        assert.include(rework.message.text, "Keep the prefix goal");
        assert.notInclude(rework.message.text, "Suffix requirement");
        assert.strictEqual((yield* runner.handle(approve(finalReview))).outcome, "conflict");
        yield* h.completeCurrent;
        const freshReview = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(freshReview.generation, 1);
        assert.notEqual(freshReview.checkpoint!.checkpointId, review.checkpoint!.checkpointId);
        const freshInput = (yield* runner.handle(approve(freshReview))).progress!;
        assert.strictEqual(freshInput.status, "awaiting_input");
        assert.notEqual(freshInput.checkpoint!.checkpointId, detail.checkpoint!.checkpointId);
        assert.strictEqual(
          freshInput.responses!.filter((response) => response.operation === "input").length,
          2,
        );
      }),
    ),
);
it.effect("serializes competing Input responses and acknowledges an identical replay once", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      const input = (yield* runner.handle(multiRequest())).progress!;
      const first = checkpointResponse(input, "input", "first answer");
      const second = { ...checkpointResponse(input, "input", "second answer"), userId: "teammate" };
      const replies = yield* Effect.all([runner.handle(first), runner.handle(second)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(replies.map((reply) => reply.outcome).sort(), [
        "accepted",
        "conflict",
      ]);
      assert.strictEqual((yield* runner.handle(first)).outcome, "accepted");
      assert.lengthOf(yield* h.starts, 1);
      assert.lengthOf((yield* runner.handle(control("status"))).progress!.responses!, 1);
    }),
  ),
);
it.effect(
  "keeps an accepted continuation waiting for capacity and cancellation prevents delivery",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        const input = (yield* runner.handle(multiRequest())).progress!;
        const store = yield* Store.WorkflowRunStore;
        const run = (yield* store.get("job-1"))!;
        yield* store.save({
          ...run,
          jobId: "other",
          executionReserved: true,
          progress: {
            ...run.progress,
            threadId: ThreadId.make("workflow:other:agent"),
            status: "running",
          },
        });
        const waiting = (yield* runner.handle(checkpointResponse(input, "input", "queue this")))
          .progress!;
        assert.strictEqual(waiting.status, "waiting_capacity");
        assert.lengthOf(yield* h.starts, 0);
        yield* runner.handle(control("cancel"));
        const other = (yield* store.get("other"))!;
        yield* store.save({
          ...other,
          executionReserved: false,
          progress: { ...other.progress, status: "done" },
        });
        assert.strictEqual((yield* runner.handle(control("status"))).progress!.status, "cancelled");
        assert.lengthOf(yield* h.starts, 0);
      }),
    ),
);
it.effect(
  "completes an Agent-only workflow after final verification without a human approval",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle({
          ...request(),
          control: {
            ...request().control,
            operation: "start",
            workflow: {
              ...workflow,
              definition: { ...workflow.definition, steps: [workflow.definition.steps[0]!] },
            },
          },
        });
        yield* h.completeCurrent;
        const done = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(done.status, "done");
        const progressEvents = (yield* Ref.get(h.commands)).filter(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "workflow.progress",
        );
        assert.isTrue(
          progressEvents.some(
            (command) =>
              command.type === "thread.activity.append" &&
              command.activity.summary === "Workflow done",
          ),
        );
        assert.isNull((yield* (yield* Store.WorkflowRunStore).get("job-1"))!.approvedBy);
      }),
    ),
);

it.effect("wakes accepted continuations when capacity returns without replaying a response", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      const input = (yield* runner.handle(multiRequest())).progress!;
      const store = yield* Store.WorkflowRunStore;
      const run = (yield* store.get("job-1"))!;
      yield* store.save({
        ...run,
        jobId: "other",
        executionReserved: true,
        progress: {
          ...run.progress,
          threadId: ThreadId.make("workflow:other:agent"),
          status: "running",
        },
      });
      yield* runner.handle(checkpointResponse(input, "input", "accepted while busy"));
      const other = (yield* store.get("other"))!;
      yield* store.save({
        ...other,
        executionReserved: false,
        progress: { ...other.progress, status: "done" },
      });
      yield* runner.handle(control("status"));
      yield* runner.handle(control("status"));
      assert.lengthOf(yield* h.starts, 1);
      assert.lengthOf((yield* runner.handle(control("status"))).progress!.responses!, 1);
    }),
  ),
);
it.effect(
  "blocks an intermediate changed result while allowing explicit rework on the same branch",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        const input = (yield* runner.handle(multiRequest())).progress!;
        yield* runner.handle(checkpointResponse(input, "input", "goal"));
        yield* h.completeCurrent;
        const review = (yield* runner.handle(control("status"))).progress!;
        yield* Ref.set(h.difference, "Unexpected edits");
        assert.strictEqual((yield* runner.handle(approve(review))).outcome, "conflict");
        assert.lengthOf(yield* h.starts, 1);
        assert.strictEqual(
          (yield* runner.handle(
            checkpointResponse(review, "request_changes", "Include these edits"),
          )).outcome,
          "accepted",
        );
        assert.lengthOf(yield* h.starts, 2);
      }),
    ),
);
it.effect(
  "automatic completion verifies the final result and retries without inventing an approver",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle({
          ...request(),
          control: {
            ...request().control,
            operation: "start",
            workflow: {
              ...workflow,
              definition: { ...workflow.definition, steps: [workflow.definition.steps[0]!] },
            },
          },
        });
        yield* h.completeCurrent;
        yield* Ref.set(h.difference, "changed");
        const blocked = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(blocked.status, "finishing");
        assert.isTrue(blocked.retryableApproval);
        yield* Ref.set(h.difference, "");
        assert.strictEqual((yield* runner.handle(approve(blocked))).progress!.status, "done");
        assert.isNull((yield* (yield* Store.WorkflowRunStore).get("job-1"))!.approvedBy);
      }),
    ),
);

it.effect(
  "automatic completion waits for background setup cleanup and releases live thread ownership",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle({
          ...request(),
          control: {
            ...request().control,
            operation: "start",
            workflow: {
              ...workflow,
              definition: { ...workflow.definition, steps: [workflow.definition.steps[0]!] },
            },
          },
        });
        yield* h.completeCurrent;
        yield* withBackground(h);
        const finishing = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(finishing.status, "finishing");
        assert.isTrue(finishing.approvalPending);
        yield* Queue.take(h.cleanups);
        yield* Queue.offer(h.cleanupOutcomes, null);
        const done = yield* h.awaitRun((run) => run.progress.status === "done");
        assert.isNull(done.approvedBy);
        assert.isFalse(done.executionReserved);
        // The command receipt is appended after the state write; a status read drains the runner's mutex.
        yield* runner.handle(control("status"));
        const activities = (yield* Ref.get(h.commands)).filter(
          (command) => command.type === "thread.activity.append",
        );
        assert.isTrue(
          activities.some(
            (command) =>
              command.type === "thread.activity.append" &&
              command.activity.summary === "Workflow done",
          ),
        );
      }),
    ),
);

it.effect.each(["before", "after"] as const)(
  "recovers a later Agent prompt %s acceptance with its same turn identity and worktree",
  (outage) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        const input = (yield* runner.handle(multiRequest())).progress!;
        yield* runner.handle(checkpointResponse(input, "input", "goal"));
        yield* h.completeCurrent;
        const review = (yield* runner.handle(control("status"))).progress!;
        const details = (yield* runner.handle(approve(review))).progress!;
        yield* Ref.set(h.promptOutage, outage);
        assert.strictEqual(
          (yield* Effect.flip(
            runner.handle(checkpointResponse(details, "input", "Later instructions")),
          ))._tag,
          "WorkflowRunnerError",
        );
        const accepted = (yield* (yield* Store.WorkflowRunStore).get("job-1"))!;
        assert.strictEqual(accepted.sequence!.cursor, 4);
        assert.isFalse(accepted.promptDispatched);
        yield* Scope.close(scope, Exit.void);
        const recovered = yield* h.newRunner;
        yield* recovered.handle(control("status"));
        const starts = yield* h.starts;
        assert.lengthOf(starts, 2);
        assert.isUndefined(starts[1]!.bootstrap);
        assert.strictEqual(starts[1]!.threadId, starts[0]!.threadId);
        assert.include(starts[1]!.message.text, "Later instructions");
        assert.isTrue((yield* (yield* Store.WorkflowRunStore).get("job-1"))!.promptDispatched);
      }),
    ),
);

it.effect(
  "reworks a job with a pinned provider identity but no saved sequence without replaying setup",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        const review = (yield* runner.handle(control("status"))).progress!;
        const store = yield* Store.WorkflowRunStore;
        const run = (yield* store.get("job-1"))!;
        yield* store.save({ ...run, sequence: undefined, promptDispatched: true, workflow });
        const rework = yield* runner.handle(
          checkpointResponse(review, "request_changes", "Revise this older result"),
        );
        assert.strictEqual(rework.outcome, "accepted");
        assert.strictEqual(rework.progress!.generation, 1);
        const starts = yield* h.starts;
        assert.lengthOf(starts, 2);
        assert.isUndefined(starts[1]!.bootstrap);
        assert.strictEqual(starts[1]!.threadId, starts[0]!.threadId);
      }),
    ),
);

it.effect.each(["driver", "account", "model", "instance-model-rule"] as const)(
  "rejects incompatible workflow providers before acceptance and Git: %s",
  (kind) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const first = (yield* Ref.get(h.providers))[0]!;
        const nextId = ProviderInstanceId.make("second-provider");
        const next = {
          ...first,
          instanceId: nextId,
          driver: ProviderDriverKind.make(kind === "driver" ? "claudeAgent" : "codex"),
          continuation: {
            groupKey:
              kind === "account" || kind === "driver"
                ? "different-home"
                : first.continuation!.groupKey,
          },
          ...(kind === "instance-model-rule" ? { requiresNewThreadForModelChange: true } : {}),
        };
        yield* Ref.set(h.providers, [
          { ...first, ...(kind === "model" ? { requiresNewThreadForModelChange: true } : {}) },
          next,
        ]);
        const runner = yield* h.newRunner;
        const reply = yield* runner.handle({
          ...request(),
          control: {
            ...request().control,
            operation: "start",
            workflow: {
              ...workflow,
              definition: {
                ...workflow.definition,
                steps: [
                  ...workflow.definition.steps,
                  {
                    id: "next",
                    kind: "agent",
                    title: "Next",
                    instruction: "Continue",
                    modelSelection: {
                      instanceId: kind === "model" ? MODEL.instanceId : nextId,
                      model: kind === "model" ? "different-model" : MODEL.model,
                    },
                  },
                ],
              },
            },
          },
        });
        assert.strictEqual(reply.outcome, "unavailable");
        assert.include(reply.detail!, "Next");
        assert.isNull(yield* (yield* Store.WorkflowRunStore).get("job-1"));
        assert.strictEqual(yield* Ref.get(h.fetches), 0);
        assert.lengthOf(yield* h.starts, 0);
      }),
    ),
);
it.effect(
  "freezes inherited defaults and allows compatible instance/model changes and rework",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const first = (yield* Ref.get(h.providers))[0]!;
        const secondModel = {
          instanceId: ProviderInstanceId.make("codex-work"),
          model: "different-model",
        };
        yield* Ref.set(h.providers, [first, { ...first, instanceId: secondModel.instanceId }]);
        const configured = {
          ...multiWorkflow,
          definition: {
            ...multiWorkflow.definition,
            steps: multiWorkflow.definition.steps.map((step) =>
              step.id === "verify" && step.kind === "agent"
                ? { ...step, modelSelection: secondModel }
                : step,
            ),
          },
        };
        const runner = yield* h.newRunner;
        const input = (yield* runner.handle({
          ...request(),
          control: { ...request().control, operation: "start", workflow: configured },
        })).progress!;
        yield* Ref.update(h.projectState, (project) => ({
          ...project,
          defaultModelSelection: { ...MODEL, model: "edited-default" },
        }));
        yield* runner.handle(checkpointResponse(input, "input", "goal"));
        assert.deepStrictEqual((yield* h.starts)[0]!.modelSelection, MODEL);
        yield* h.completeCurrent;
        const review = (yield* runner.handle(control("status"))).progress!;
        const details = (yield* runner.handle(approve(review))).progress!;
        yield* runner.handle(checkpointResponse(details, "input", "requirements"));
        assert.deepStrictEqual((yield* h.starts)[1]!.modelSelection, secondModel);
        yield* h.completeCurrent;
        const final = (yield* runner.handle(control("status"))).progress!;
        yield* runner.handle(checkpointResponse(final, "request_changes", "revise"));
        assert.deepStrictEqual((yield* h.starts)[2]!.modelSelection, MODEL);
      }),
    ),
);
it.effect.each(["first-agent", "next-agent", "rework", "restart", "legacy"] as const)(
  "pins provider resume identity across continuation: %s",
  (kind) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        let runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        const input = (yield* runner.handle(multiRequest())).progress!;
        let pending = input;
        if (kind !== "first-agent") {
          yield* runner.handle(checkpointResponse(input, "input", "goal"));
          yield* h.completeCurrent;
          const review = (yield* runner.handle(control("status"))).progress!;
          pending = kind === "rework" ? review : (yield* runner.handle(approve(review))).progress!;
        }
        const store = yield* Store.WorkflowRunStore;
        const original = (yield* store.get("job-1"))!;
        if (kind === "legacy") yield* store.save({ ...original, providerContinuation: undefined });
        else
          yield* Ref.update(h.providers, (entries) =>
            entries.map((provider) => ({
              ...provider,
              continuation: { groupKey: "codex:changed-home" },
            })),
          );
        if (kind === "restart") {
          yield* Scope.close(scope, Exit.void);
          runner = yield* h.newRunner;
          pending = (yield* runner.handle(control("status"))).progress!;
        }
        const before = (yield* h.starts).length;
        const paused = (yield* runner.handle(
          checkpointResponse(pending, kind === "rework" ? "request_changes" : "input", "continue"),
        )).progress!;
        assert.strictEqual(paused.status, "paused");
        assert.isFalse(paused.retryablePreparation);
        assert.include(paused.detail!, "Cancel this job");
        assert.lengthOf(yield* h.starts, before);
        assert.deepStrictEqual(
          (yield* store.get("job-1"))!.providerContinuation,
          kind === "legacy" ? undefined : original.providerContinuation,
        );
        assert.isNotNull((yield* runner.handle(control("status"))).progress);
        const cancellation = (yield* runner.handle(control("cancel"))).progress!;
        if (before > 0) {
          assert.strictEqual(cancellation.status, "cancelling");
          yield* Ref.update(h.currentThread, (current) => ({
            ...current!,
            session: null,
            promptQueue: {
              ...current!.promptQueue!,
              preparation: {
                ...current!.promptQueue!.preparation!,
                state: "failed" as const,
                settled: true,
              },
            },
          }));
          assert.strictEqual(
            (yield* runner.handle(control("status"))).progress!.status,
            "cancelled",
          );
        } else assert.strictEqual(cancellation.status, "cancelled");
      }),
    ),
);
it.effect(
  "surfaces a durable enqueue rejection without retrying or releasing its reservation",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* Ref.set(h.promptOutage, "reject");
        const runner = yield* h.newRunner;
        const reply = (yield* runner.handle(request())).progress!;
        assert.strictEqual(reply.status, "paused");
        assert.include(reply.detail!, "durable enqueue rejection");
        assert.isFalse(reply.retryablePreparation);
        yield* runner.handle(control("status"));
        assert.lengthOf(yield* h.starts, 0);
        assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
        assert.strictEqual((yield* runner.handle(control("cancel"))).progress!.status, "cancelled");
      }),
    ),
);
it.effect.each(["success", "failed", "waiter-cancelled"] as const)(
  "cleanup completion wakes capacity without another status request: %s",
  (mode) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        const input = (yield* runner.handle(multiRequest())).progress!;
        yield* runner.handle(request("executing"));
        assert.strictEqual((yield* h.awaitPrompt).threadId, "workflow:executing:agent");
        const waiting = (yield* runner.handle(
          checkpointResponse(input, "input", "continue when free"),
        )).progress!;
        assert.strictEqual(waiting.status, "waiting_capacity");
        yield* Ref.update(h.currentThread, (current) => ({
          ...completed(current!),
          promptQueue: {
            ...completed(current!).promptQueue!,
            preparation: {
              ...completed(current!).promptQueue!.preparation!,
              script: backgroundScript,
              settled: false,
            },
          },
        }));
        yield* runner.handle(control("cancel", "executing"));
        yield* Queue.take(h.cleanups);
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          session: null,
          promptQueue: {
            ...current!.promptQueue!,
            preparation: {
              ...current!.promptQueue!.preparation!,
              state: "failed" as const,
              settled: true,
            },
          },
        }));
        if (mode === "waiter-cancelled") yield* runner.handle(control("cancel"));
        yield* Queue.offer(
          h.cleanupOutcomes,
          mode === "failed" ? "cleanup ownership uncertain" : null,
        );
        if (mode === "success") {
          assert.strictEqual((yield* h.awaitPrompt).threadId, "workflow:job-1:agent");
          assert.lengthOf(yield* h.starts, 2);
          const now = yield* Store.WorkflowRunStore;
          assert.isNull(yield* now.getByThread("workflow:executing:agent"));
          // A stale terminal event cannot dispatch an already-admitted successor again.
          yield* h.emit({
            sequence: 1,
            eventId: EventId.make("late-cleanup-event"),
            aggregateKind: "thread",
            aggregateId: ThreadId.make("workflow:executing:agent"),
            occurredAt: NOW,
            commandId: CommandId.make("late-cleanup-command"),
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.activity-appended",
            payload: {
              threadId: ThreadId.make("workflow:executing:agent"),
              activity: {
                id: EventId.make("late-cleanup-activity"),
                kind: "workflow.progress",
                tone: "info",
                summary: "Cancelled",
                payload: {},
                turnId: null,
                createdAt: NOW,
              },
            },
          });
          yield* runner.handle(control("status"));
          assert.lengthOf(yield* h.starts, 2);
        } else {
          yield* h.awaitRun(
            (run) =>
              run.jobId === "executing" &&
              (mode === "failed"
                ? !!run.progress.retryableCancellation
                : run.progress.status === "cancelled"),
          );
          assert.lengthOf(yield* h.starts, 1);
          if (mode === "failed")
            assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
        }
      }),
    ),
);

it.effect(
  "pauses legacy rework without a historical provider identity and retains its saved files and thread results",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        const review = (yield* runner.handle(control("status"))).progress!;
        const store = yield* Store.WorkflowRunStore;
        const saved = (yield* store.get("job-1"))!;
        const checkpoints = (yield* Ref.get(h.currentThread))!.checkpoints;
        yield* store.save({
          ...saved,
          sequence: undefined,
          providerContinuation: undefined,
          promptDispatched: true,
          workflow,
        });
        const rework = (yield* runner.handle(
          checkpointResponse(review, "request_changes", "Revise the legacy result"),
        )).progress!;
        assert.strictEqual(rework.status, "paused");
        assert.include(rework.detail!, "original provider compatibility is unavailable");
        assert.strictEqual((yield* store.get("job-1"))!.preparedHead, saved.preparedHead);
        assert.deepStrictEqual((yield* Ref.get(h.currentThread))!.checkpoints, checkpoints);
        assert.lengthOf(yield* h.starts, 1);
        assert.strictEqual(
          (yield* runner.handle(control("cancel"))).progress!.status,
          "cancelling",
        );
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          session: null,
          promptQueue: {
            ...current!.promptQueue!,
            preparation: {
              ...current!.promptQueue!.preparation!,
              state: "failed" as const,
              settled: true,
            },
          },
        }));
        assert.strictEqual((yield* runner.handle(control("status"))).progress!.status, "cancelled");
      }),
    ),
);

it.effect("retains capacity when stopped projection lacks provider proof", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.providerProof, false);
    const runner = yield* h.newRunner;
    yield* runner.handle(request());
    yield* h.awaitPrompt;
    yield* Ref.update(h.currentThread, (current) => ({
      ...current!,
      session: {
        threadId: current!.id,
        status: "stopped" as const,
        providerName: "codex",
        runtimeMode: "approval-required" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
      promptQueue: { ...current!.promptQueue!, preparation: undefined },
    }));
    const pending = (yield* runner.handle(control("cancel"))).progress!;
    assert.strictEqual(pending.status, "cancelling");
    assert.strictEqual(
      (yield* (yield* Store.WorkflowRunStore).get("job-1"))!.executionReserved,
      true,
    );
    yield* Ref.set(h.providerProof, true);
    assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
  }).pipe(Effect.provide(persistence)),
);

function manualRequest(
  progress: NonNullable<import("@t3tools/contracts/workflows").WorkflowControlResult["progress"]>,
  operation: "pause" | "resume",
  controlId = `${operation}-${progress.revision}`,
): WorkflowRequest {
  return {
    ...request(),
    control: {
      ...control("status").control,
      operation,
      controlId,
      expectedRevision: progress.revision,
    },
  };
}

it.effect("manual Pause preserves Input and Review checkpoints, previews and responses", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      const input = (yield* runner.handle(multiRequest())).progress!;
      const paused = (yield* runner.handle(manualRequest(input, "pause"))).progress!;
      assert.strictEqual(paused.status, "paused");
      assert.strictEqual(paused.underlyingStatus, "awaiting_input");
      assert.strictEqual(paused.checkpoint!.checkpointId, input.checkpoint!.checkpointId);
      assert.isFalse(paused.hasThread);
      assert.lengthOf(yield* h.starts, 0);
      assert.strictEqual(
        (yield* runner.handle(checkpointResponse(paused, "input", "keep draft"))).outcome,
        "conflict",
      );
      const resumed = (yield* runner.handle(manualRequest(paused, "resume"))).progress!;
      assert.strictEqual(resumed.status, "awaiting_input");
      yield* runner.handle(checkpointResponse(resumed, "input", "keep answer"));
      yield* h.completeCurrent;
      yield* withBackground(h);
      const review = (yield* runner.handle(control("status"))).progress!;
      const reviewPaused = (yield* runner.handle(manualRequest(review, "pause"))).progress!;
      assert.strictEqual((yield* runner.handle(approve(reviewPaused))).outcome, "conflict");
      assert.strictEqual(yield* Queue.size(h.cleanups), 0);
      const restored = (yield* runner.handle(manualRequest(reviewPaused, "resume"))).progress!;
      assert.strictEqual(restored.checkpoint!.checkpointId, review.checkpoint!.checkpointId);
      assert.deepStrictEqual(restored.responses, review.responses);
      assert.strictEqual(restored.status, "awaiting_review");
    }),
  ),
);

it.effect(
  "manual Pause finishes one reserved Agent and blocks its automatic successor across restart",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        let runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        const started = (yield* runner.handle({
          ...request(),
          control: {
            ...request().control,
            operation: "start",
            workflow: {
              ...workflow,
              definition: {
                ...workflow.definition,
                steps: [
                  workflow.definition.steps[0]!,
                  {
                    ...workflow.definition.steps[0]!,
                    id: "second-agent",
                  },
                  workflow.definition.steps[1]!,
                ],
              },
            },
          },
        })).progress!;
        const requested = (yield* runner.handle(manualRequest(started, "pause"))).progress!;
        assert.strictEqual(requested.manualPause?.state, "requested");
        assert.notEqual(requested.status, "paused");
        assert.lengthOf(yield* h.starts, 1);
        yield* h.completeCurrent;
        const paused = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(paused.manualPause?.state, "paused");
        assert.strictEqual(paused.underlyingStatus, "waiting_capacity");
        assert.lengthOf(yield* h.starts, 1);
        const store = yield* Store.WorkflowRunStore;
        assert.isFalse((yield* store.get("job-1"))!.executionReserved);
        yield* Scope.close(scope, Exit.void);
        runner = yield* h.newRunner;
        const recovered = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(recovered.status, "paused");
        assert.lengthOf(yield* h.starts, 1);
        yield* runner.handle(manualRequest(recovered, "resume"));
        const starts = yield* h.starts;
        assert.lengthOf(starts, 2);
        assert.isUndefined(starts[1]!.bootstrap);
        assert.strictEqual(starts[1]!.threadId, starts[0]!.threadId);
      }),
    ),
);

it.effect("manual Pause at the last Agent blocks final completion and setup cleanup", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      const started = (yield* runner.handle({
        ...request(),
        control: {
          ...request().control,
          operation: "start",
          workflow: {
            ...workflow,
            definition: { ...workflow.definition, steps: [workflow.definition.steps[0]!] },
          },
        },
      })).progress!;
      yield* runner.handle(manualRequest(started, "pause"));
      yield* h.completeCurrent;
      yield* withBackground(h);
      const paused = (yield* runner.handle(control("status"))).progress!;
      assert.strictEqual(paused.status, "paused");
      assert.strictEqual(paused.underlyingStatus, "finishing");
      assert.strictEqual(yield* Queue.size(h.cleanups), 0);
      const store = yield* Store.WorkflowRunStore;
      assert.isUndefined((yield* store.get("job-1"))!.approvalAttempt);
      yield* runner.handle(manualRequest(paused, "resume"));
      yield* Queue.take(h.cleanups);
      yield* Queue.offer(h.cleanupOutcomes, null);
      assert.strictEqual(
        (yield* h.awaitRun((run) => run.progress.status === "done")).progress.status,
        "done",
      );
      assert.lengthOf(yield* h.starts, 1);
    }),
  ),
);

it.effect(
  "manual control retries are idempotent and an old Pause cannot reapply after Resume",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        const input = (yield* runner.handle(multiRequest())).progress!;
        const pause = manualRequest(input, "pause", "stable-pause");
        const paused = (yield* runner.handle(pause)).progress!;
        const replay = (yield* runner.handle(pause)).progress!;
        assert.strictEqual(replay.revision, paused.revision);
        const collision = manualRequest(input, "resume", "stable-pause");
        assert.strictEqual((yield* runner.handle(collision)).outcome, "conflict");
        const resume = manualRequest(paused, "resume", "stable-resume");
        const resumed = (yield* runner.handle(resume)).progress!;
        assert.strictEqual((yield* runner.handle(resume)).progress?.revision, resumed.revision);
        assert.strictEqual((yield* runner.handle(pause)).outcome, "conflict");
        assert.isNull((yield* runner.handle(control("status"))).progress!.manualPause);
        yield* runner.handle(control("cancel"));
        assert.strictEqual((yield* runner.handle(resume)).outcome, "conflict");
        assert.lengthOf(yield* h.starts, 0);
      }),
    ),
);

it.effect("Resume removes only the manual hold and does not retry failed preparation", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      const started = (yield* runner.handle(request())).progress!;
      yield* runner.handle(manualRequest(started, "pause"));
      yield* h.failPreparation;
      const failed = (yield* runner.handle(control("status"))).progress!;
      assert.strictEqual(failed.underlyingStatus, "paused");
      assert.strictEqual(failed.manualPause?.state, "requested");
      assert.strictEqual((yield* runner.handle(retryRequest(failed.revision))).outcome, "conflict");
      const resumed = (yield* runner.handle(manualRequest(failed, "resume"))).progress!;
      assert.strictEqual(resumed.status, "paused");
      assert.isNull(resumed.manualPause);
      assert.isTrue(resumed.retryablePreparation);
      assert.lengthOf(
        (yield* Ref.get(h.commands)).filter(
          (command) => command.type === "thread.preparation.retry",
        ),
        0,
      );
      assert.isTrue((yield* (yield* Store.WorkflowRunStore).get("job-1"))!.executionReserved);
    }),
  ),
);

it.effect("manual Pause survives unknown delivery and Resume never redelivers it", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      const started = (yield* runner.handle(request())).progress!;
      yield* runner.handle(manualRequest(started, "pause"));
      let current = (yield* Ref.get(h.currentThread))!;
      current = {
        ...current,
        promptQueue: {
          ...current.promptQueue!,
          preparation: {
            ...current.promptQueue!.preparation!,
            state: "ready",
            settled: true,
          },
        },
      };
      const apply = Effect.fn(function* (command: Parameters<typeof decidePromptQueueCommand>[1]) {
        const events = yield* decidePromptQueueCommand(current, command, false);
        let state: OrchestrationReadModel = { ...createEmptyReadModel(NOW), threads: [current] };
        for (const event of events)
          state = yield* projectEvent(state, { ...event, sequence: state.snapshotSequence + 1 });
        current = state.threads[0]!;
      });
      yield* apply({
        type: "thread.prompt.enqueue",
        commandId: CommandId.make("pause-enqueue"),
        threadId: current.id,
        message: {
          messageId: MessageId.make("workflow:job-1:prompt"),
          text: "work",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: NOW,
      });
      yield* apply({
        type: "thread.prompt.claim",
        commandId: CommandId.make("pause-claim"),
        threadId: current.id,
        messageId: MessageId.make("workflow:job-1:prompt"),
        expectedRevision: current.promptQueue!.entries[0]!.revision,
        expectedControlRevision: current.promptQueue!.revision,
        createdAt: NOW,
      });
      yield* apply({
        type: "thread.prompt.unknown",
        commandId: CommandId.make("pause-unknown"),
        threadId: current.id,
        attemptId: CommandId.make("pause-claim"),
        detail: "Lost delivery acknowledgement",
        createdAt: NOW,
      });
      yield* Ref.set(h.currentThread, current);
      const uncertain = (yield* runner.handle(control("status"))).progress!;
      assert.strictEqual(uncertain.underlyingStatus, "paused");
      assert.isFalse(uncertain.retryablePreparation);
      yield* runner.handle(manualRequest(uncertain, "resume"));
      assert.lengthOf(yield* h.starts, 1);
      assert.isTrue((yield* (yield* Store.WorkflowRunStore).get("job-1"))!.executionReserved);
    }),
  ),
);

it.effect("manual Pause rejects unaccepted and legacy jobs without changing their ownership", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      assert.strictEqual(
        (yield* runner.handle({
          ...request(),
          control: {
            ...control("status").control,
            operation: "pause",
            controlId: "no-job",
            expectedRevision: 0,
          },
        })).outcome,
        "conflict",
      );
      const started = (yield* runner.handle(request())).progress!;
      const store = yield* Store.WorkflowRunStore;
      const run = (yield* store.get("job-1"))!;
      yield* store.save({ ...run, sequence: undefined });
      assert.strictEqual(
        (yield* runner.handle(manualRequest(started, "pause"))).outcome,
        "unavailable",
      );
      assert.isTrue((yield* store.get("job-1"))!.executionReserved);
      assert.lengthOf(yield* h.starts, 1);
    }),
  ),
);

it.effect.each(["event", "restart", "lost-enqueue-reply"] as const)(
  "a requested Pause recovers the current step without duplicate delivery: %s",
  (mode) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        let runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        if (mode === "lost-enqueue-reply") {
          yield* Ref.set(h.promptOutage, "after");
          yield* runner.handle(request()).pipe(Effect.flip);
        } else yield* runner.handle(request());
        const store = yield* Store.WorkflowRunStore;
        const saved = (yield* store.get("job-1"))!;
        yield* runner.handle(manualRequest(saved.progress, "pause"));
        assert.lengthOf(yield* h.starts, 1);
        yield* h.completeCurrent;
        if (mode === "event") {
          const threadId = ThreadId.make("workflow:job-1:agent");
          yield* h.emit({
            sequence: 1,
            eventId: EventId.make("pause-completion"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: NOW,
            commandId: CommandId.make("pause-completion"),
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.activity-appended",
            payload: {
              threadId,
              activity: {
                id: EventId.make("pause-completion"),
                kind: "workflow.progress",
                tone: "info",
                summary: "Completed",
                payload: {},
                turnId: null,
                createdAt: NOW,
              },
            },
          });
          yield* h.awaitRun((run) => run.manualPause?.state === "paused");
        } else {
          yield* Scope.close(scope, Exit.void);
          runner = yield* h.newRunner;
        }
        const paused = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(paused.manualPause?.state, "paused");
        assert.strictEqual(paused.underlyingStatus, "awaiting_review");
        assert.lengthOf(yield* h.starts, 1);
      }),
    ),
);

it.effect(
  "a paused capacity waiter stays held while other jobs run and Resume waits for its slot",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        const input = (yield* runner.handle(multiRequest())).progress!;
        yield* runner.handle(request("other-job"));
        const waiting = (yield* runner.handle(
          checkpointResponse(input, "input", "wait for the slot"),
        )).progress!;
        assert.strictEqual(waiting.status, "waiting_capacity");
        const paused = (yield* runner.handle(manualRequest(waiting, "pause"))).progress!;
        assert.strictEqual(paused.manualPause?.state, "paused");
        assert.lengthOf(yield* h.starts, 1);
        const resumed = (yield* runner.handle(manualRequest(paused, "resume"))).progress!;
        assert.strictEqual(resumed.status, "waiting_capacity");
        assert.lengthOf(yield* h.starts, 1);
        const store = yield* Store.WorkflowRunStore;
        assert.isFalse((yield* store.get("job-1"))!.executionReserved);
        assert.isTrue((yield* store.get("other-job"))!.executionReserved);
      }),
    ),
);

it.effect("publishing runs outside the control mutex and keeps Pause at the action boundary", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const actionService = WorkflowActions.of({
        available: Effect.succeed(true),
        recover: () => Effect.succeed(true),
        execute: (id, io) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            yield* Ref.set(h.head, "published-sha");
            yield* io.update((run) => ({
              ...changeWorkflowAction(run, id, (action) => ({
                ...action,
                state: "completed",
                phase: "done",
                commitSha: "published-sha",
              })),
              preparedHead: "published-sha",
            }));
          }),
      });
      const runner = yield* h.newRunner.pipe(Effect.provideService(WorkflowActions, actionService));
      const original = request();
      const start: WorkflowRequest = {
        ...original,
        control: {
          ...original.control,
          operation: "start",
          workflow: {
            ...workflow,
            definition: {
              ...workflow.definition,
              steps: [
                ...workflow.definition.steps,
                { id: "push", kind: "action", title: "Push branch", action: "push" },
              ],
            },
          },
        },
      };
      assert.equal((yield* runner.handle(start)).protocol, 7);
      yield* h.complete;
      const review = (yield* runner.handle(control("status"))).progress!;
      yield* runner.handle(approve(review));
      yield* Deferred.await(started);
      const running = (yield* runner.handle(control("status"))).progress!;
      const paused = yield* runner.handle({
        ...control("status"),
        control: {
          ...control("status").control,
          operation: "pause",
          controlId: "hold-push",
          expectedRevision: running.revision,
        },
      });
      assert.equal(paused.progress?.manualPause?.state, "requested");
      yield* Deferred.succeed(release, undefined);
      yield* h.awaitRun((run) => run.manualPause?.state === "paused");
      const held = (yield* runner.handle(control("status"))).progress!;
      assert.equal(held.manualPause?.state, "paused");
      assert.equal(held.actions?.[0]?.state, "completed");
      yield* runner.handle({
        ...control("status"),
        control: {
          ...control("status").control,
          operation: "resume",
          controlId: "resume-push",
          expectedRevision: held.revision,
        },
      });
      const done = (yield* runner.handle(control("status"))).progress!;
      assert.equal(done.status, "done");
      assert.equal(
        (yield* (yield* Store.WorkflowRunStore).get("job-1"))?.preparedHead,
        "published-sha",
      );
      assert.equal((yield* h.starts).length, 1);
    }),
  ),
);

it.effect(
  "Cancel interrupts publishing and keeps controls responsive while native cleanup is uncertain",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const recoveries = yield* Queue.unbounded<void>();
        const outcomes = yield* Queue.unbounded<boolean>();
        const service = WorkflowActions.of({
          available: Effect.succeed(true),
          execute: (id, io) =>
            Effect.gen(function* () {
              yield* io.update((run) =>
                changeWorkflowAction(run, id, (action) => ({
                  ...action,
                  commands: [
                    {
                      id: "command",
                      phase: "push",
                      pid: 42,
                      identity: "birth",
                      boot: { host: "host", session: "boot" },
                      stopped: false,
                      code: null,
                    },
                  ],
                })),
              );
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
          recover: (io) =>
            Effect.gen(function* () {
              yield* Queue.offer(recoveries, undefined);
              const stopped = yield* Queue.take(outcomes);
              if (stopped)
                yield* io.update((run) => ({
                  ...run,
                  actions: run.actions?.map((action) => ({
                    ...action,
                    commands: action.commands.map((command) => ({ ...command, stopped: true })),
                  })),
                }));
              return stopped;
            }),
        });
        const runner = yield* h.newRunner.pipe(Effect.provideService(WorkflowActions, service));
        const original = request();
        yield* runner.handle({
          ...original,
          control: {
            ...original.control,
            operation: "start",
            workflow: {
              ...workflow,
              definition: {
                ...workflow.definition,
                steps: [
                  ...workflow.definition.steps,
                  { id: "push", title: "Push branch", kind: "action", action: "push" },
                ],
              },
            },
          },
        });
        yield* h.complete;
        const review = (yield* runner.handle(control("status"))).progress!;
        yield* runner.handle(approve(review));
        yield* Deferred.await(started);
        assert.equal((yield* runner.handle(control("cancel"))).progress?.status, "cancelling");
        yield* Deferred.await(interrupted);
        yield* Queue.take(recoveries);
        assert.equal((yield* runner.handle(control("status"))).progress?.status, "cancelling");
        assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
        yield* Queue.offer(outcomes, false);
        const blocked = yield* h.awaitRun((run) => run.progress.retryableCancellation === true);
        assert.isTrue(blocked.executionReserved);
        assert.equal(blocked.actions?.[0]?.commands[0]?.stopped, false);
        yield* Ref.update(h.currentThread, (thread) => ({
          ...thread!,
          session: { ...thread!.session!, status: "stopped" as const },
        }));
        yield* Ref.set(h.providerProof, true);
        const retry = control("status");
        yield* runner.handle({
          ...retry,
          control: {
            ...retry.control,
            operation: "retry_cancellation",
            expectedRevision: blocked.progress.revision,
          },
        });
        yield* Queue.take(recoveries);
        yield* Queue.offer(outcomes, true);
        const cancelled = yield* h.awaitRun((run) => run.progress.status === "cancelled");
        assert.isFalse(cancelled.executionReserved);
        assert.isTrue(cancelled.actions![0]!.commands[0]!.stopped);
        assert.equal((yield* h.starts).length, 1);
      }),
    ),
);

/** Persist the state a crash leaves; gracefully stopping a worker would mark it uncertain. */
const seedPublishingRecovery = Effect.fn(function* (
  h: Effect.Success<typeof harness>,
  operation: Store.WorkflowActionRecord["operation"] = "push",
  successor = false,
) {
  const bootstrap = yield* h.newRunner;
  yield* bootstrap.handle(request());
  yield* h.complete;
  yield* bootstrap.handle(control("status"));
  const store = yield* Store.WorkflowRunStore;
  const saved = (yield* store.get("job-1"))!;
  const checkpoint = saved.progress.checkpoint;
  if (!checkpoint || checkpoint.kind === "input")
    return yield* Effect.die("Publishing recovery needs the saved Agent checkpoint.");
  const stepId = operation === "push" ? "push" : "pr";
  const action: Store.WorkflowActionRecord = {
    actionId: `workflow:job-1:action:${stepId}:0`,
    stepId,
    generation: 0,
    operation,
    state: "running",
    phase: operation === "push" ? "push" : "pull_request",
    parent: "base-sha",
    tree: "prepared-tree",
    checkpointRef: checkpoint.checkpointRef,
    commitMessage: "Implement",
    commitSha: operation === "push" ? "published-sha" : null,
    oldRemoteSha: null,
    prTitle: operation === "push" ? null : "Implement",
    prBody: operation === "push" ? null : "Saved body <!-- launchpad-workflow-job:job-1 -->",
    pullRequestUrl: null,
    detail: null,
    commands: [
      {
        id: "saved-command",
        phase: operation === "push" ? "push" : "pull_request",
        pid: 42,
        identity: "saved-birth",
        boot: { host: "host", session: "boot" },
        stopped: false,
        code: 0,
      },
    ],
  };
  const run: Store.WorkflowRun = {
    ...saved,
    workflow: {
      ...saved.workflow,
      definition: {
        ...saved.workflow.definition,
        steps: [
          ...saved.workflow.definition.steps,
          { id: "push", kind: "action", title: "Push", action: "push" },
          ...(operation === "open_pull_request" || successor
            ? [
                {
                  id: "pr",
                  kind: "action" as const,
                  title: "Open PR",
                  action: "open_pull_request" as const,
                },
              ]
            : []),
        ],
      },
    },
    sequence: {
      ...saved.sequence!,
      cursor: operation === "push" ? 2 : 3,
      completed: [
        ...saved.sequence!.completed,
        { stepId: "review", generation: 0, checkpoint: null, head: null },
        ...(operation === "open_pull_request"
          ? [{ stepId: "push", generation: 0, checkpoint: null, head: "published-sha" }]
          : []),
      ],
    },
    preparedHead: "published-sha",
    publication: {
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/repo.git",
      publishedHead: operation === "open_pull_request" ? "published-sha" : null,
      pullRequestUrl: null,
    },
    manualPause: { state: "requested", promptId: `workflow:job-1:step:${stepId}:0:prompt` },
    lastManualControl: {
      operation: "pause",
      controlId: "saved-pause",
      expectedRevision: saved.progress.revision,
    },
    executionReserved: true,
    progress: { ...saved.progress, status: "running", checkpoint: null, stepId },
    actions: [
      ...(operation === "open_pull_request"
        ? [
            {
              ...action,
              actionId: "workflow:job-1:action:push:0",
              stepId: "push",
              operation: "push" as const,
              state: "completed" as const,
              phase: "done" as const,
              commitSha: "published-sha",
              commands: [],
            },
          ]
        : []),
      action,
    ],
  };
  yield* Ref.set(h.head, "published-sha");
  return yield* store.save(run);
});

for (const status of ["done", "cancelled", "failed"] as const)
  for (const completedAction of [false, true])
    it.effect(
      `terminal ${status} never restarts publishing with ${completedAction ? "completed" : "absent"} intent`,
      () =>
        test(
          Effect.gen(function* () {
            const h = yield* harness;
            const seed = yield* seedPublishingRecovery(h);
            const store = yield* Store.WorkflowRunStore;
            const terminal = yield* store.save({
              ...seed,
              manualPause: null,
              executionReserved: false,
              progress: { ...seed.progress, status },
              actions: completedAction
                ? seed.actions!.map((action) => ({
                    ...action,
                    state: "completed",
                    phase: "done",
                    commands: [],
                  }))
                : [],
            });
            let executions = 0;
            let recoveries = 0;
            const runner = yield* h.newRunner.pipe(
              Effect.provideService(
                WorkflowActions,
                WorkflowActions.of({
                  available: Effect.succeed(true),
                  execute: () =>
                    Effect.sync(() => {
                      executions++;
                    }).pipe(Effect.andThen(Effect.never)),
                  recover: () =>
                    Effect.sync(() => {
                      recoveries++;
                      return true;
                    }),
                }),
              ),
            );
            for (let index = 0; index < 2; index++)
              assert.equal((yield* runner.handle(control("status"))).progress?.status, status);
            yield* runner.handle(control("cancel"));
            yield* runner.handle({
              ...control("status"),
              control: {
                ...control("status").control,
                operation: "retry_action",
                actionId: "workflow:job-1:action:push:0",
                expectedRevision: terminal.progress.revision,
              },
            });
            assert.deepEqual(yield* store.get("job-1"), terminal);
            assert.equal(executions, 0);
            assert.equal(recoveries, 0);
            assert.lengthOf(yield* h.starts, 1);
            assert.isFalse(yield* store.isExecuting());
          }),
        ),
    );

for (const operation of ["push", "open_pull_request"] as const)
  it.effect(
    `requested Pause recovers reserved ${operation} once and blocks its next boundary`,
    () =>
      test(
        Effect.gen(function* () {
          const h = yield* harness;
          const seed = yield* seedPublishingRecovery(h, operation, operation === "push");
          const store = yield* Store.WorkflowRunStore;
          yield* store.save({
            ...seed,
            jobId: "other-job",
            manualPause: null,
            lastManualControl: undefined,
            workflow: {
              ...seed.workflow,
              definition: { ...seed.workflow.definition, steps: workflow.definition.steps },
            },
            worktreePath: null,
            preparedHead: null,
            promptDispatched: false,
            executionReserved: false,
            publication: undefined,
            actions: [],
            sequence: {
              ...seed.sequence!,
              cursor: 0,
              started: false,
              completed: [],
              responses: [],
            },
            progress: {
              ...seed.progress,
              threadId: ThreadId.make("workflow:other-job:agent"),
              status: "waiting_capacity",
              stepId: "agent",
              checkpoint: null,
            },
          });
          const started = yield* Deferred.make<void>();
          const stopped = yield* Deferred.make<void>();
          const ids: string[] = [];
          const recover = (io: WorkflowActionIO) =>
            Deferred.await(stopped).pipe(
              Effect.andThen(
                io.update((run) => ({
                  ...run,
                  actions: run.actions?.map((action) => ({
                    ...action,
                    commands: action.commands.map((command) => ({ ...command, stopped: true })),
                  })),
                })),
              ),
              Effect.as(true),
            );
          const runner = yield* h.newRunner.pipe(
            Effect.provideService(
              WorkflowActions,
              WorkflowActions.of({
                available: Effect.succeed(true),
                recover,
                execute: (id, io) =>
                  Effect.gen(function* () {
                    ids.push(id);
                    yield* Deferred.succeed(started, undefined);
                    yield* recover(io);
                    yield* io.update((run) => ({
                      ...changeWorkflowAction(run, id, (action) => ({
                        ...action,
                        state: "completed",
                        phase: "done",
                        commitSha: "published-sha",
                      })),
                      publication: {
                        ...run.publication!,
                        publishedHead: "published-sha",
                        pullRequestUrl:
                          operation === "open_pull_request"
                            ? "https://github.com/acme/repo/pull/17"
                            : null,
                      },
                    }));
                  }),
              }),
            ),
          );
          yield* Deferred.await(started);
          for (let index = 0; index < 2; index++) {
            const active = (yield* runner.handle(control("status"))).progress!;
            assert.equal(active.manualPause?.state, "requested");
            assert.equal(active.status, "running");
          }
          assert.isTrue(yield* store.isExecuting());
          assert.isFalse((yield* store.get("other-job"))!.executionReserved);
          assert.deepEqual(ids, [seed.actions!.at(-1)!.actionId]);
          yield* Deferred.succeed(stopped, undefined);
          const paused = yield* h.awaitRun((run) => run.manualPause?.state === "paused");
          assert.isFalse(paused.executionReserved);
          assert.equal(paused.sequence!.cursor, seed.sequence!.cursor + 1);
          assert.equal(
            paused.progress.status,
            operation === "push" ? "waiting_capacity" : "finishing",
          );
          assert.deepEqual(paused.lastManualControl, seed.lastManualControl);
          assert.deepEqual(
            paused.actions!.at(-1)!.commands,
            seed.actions!.at(-1)!.commands.map((command) => ({ ...command, stopped: true })),
          );
          assert.equal(paused.actions!.at(-1)!.prBody, seed.actions!.at(-1)!.prBody);
          assert.lengthOf(
            (yield* h.starts).filter((command) => command.threadId === seed.progress.threadId),
            1,
          );
          assert.isUndefined(paused.approvalAttempt);
          assert.equal(yield* Queue.size(h.cleanups), 0);
          yield* runner.handle(control("status"));
          assert.lengthOf(ids, 1);
          yield* h.awaitRun((run) => run.jobId === "other-job" && run.executionReserved);
          assert.isTrue((yield* store.get("other-job"))!.executionReserved);
          assert.equal((yield* store.get("job-1"))!.manualPause?.state, "paused");
        }),
      ),
  );

for (const excluded of ["uncertain", "failed", "paused", "unreserved", "missing-intent"] as const)
  it.effect(`requested-hold recovery does not admit ${excluded} actions`, () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const seed = yield* seedPublishingRecovery(h);
        const store = yield* Store.WorkflowRunStore;
        yield* store.save({
          ...seed,
          executionReserved: excluded !== "unreserved" && excluded !== "paused",
          manualPause: { state: excluded === "paused" ? "paused" : "requested", promptId: "saved" },
          actions:
            excluded === "missing-intent"
              ? []
              : seed.actions!.map((action) => ({
                  ...action,
                  state: excluded === "uncertain" || excluded === "failed" ? excluded : "running",
                })),
        });
        let executions = 0;
        const runner = yield* h.newRunner.pipe(
          Effect.provideService(
            WorkflowActions,
            WorkflowActions.of({
              available: Effect.succeed(true),
              recover: () => Effect.succeed(true),
              execute: () =>
                Effect.sync(() => {
                  executions++;
                }).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        );
        yield* runner.handle(control("status"));
        assert.equal(executions, 0);
        assert.equal((yield* store.get("job-1"))!.sequence!.cursor, seed.sequence!.cursor);
        assert.lengthOf(yield* h.starts, 1);
      }),
    ),
  );

it.effect("requested-hold recovery keeps ownership when stopping cannot be proven", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      yield* seedPublishingRecovery(h);
      const recover = () => Effect.succeed(false);
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(
          WorkflowActions,
          WorkflowActions.of({
            available: Effect.succeed(true),
            recover,
            execute: () =>
              recover().pipe(
                Effect.andThen(
                  Effect.fail(new WorkflowActionError({ message: "Cleanup unconfirmed" })),
                ),
              ),
          }),
        ),
      );
      yield* runner.handle(control("status"));
      const failed = yield* h.awaitRun((run) => run.actions?.at(-1)?.state === "uncertain");
      assert.isTrue(failed.executionReserved);
      assert.equal(failed.manualPause?.state, "requested");
      assert.include(failed.progress.detail!, "Cleanup unconfirmed");
      assert.isFalse(failed.actions!.at(-1)!.commands[0]!.stopped);
    }),
  ),
);

it.effect("Resume during reserved-action recovery does not launch a second worker", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      yield* seedPublishingRecovery(h);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let executions = 0;
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(
          WorkflowActions,
          WorkflowActions.of({
            available: Effect.succeed(true),
            recover: () => Effect.succeed(true),
            execute: (id, io) =>
              Effect.gen(function* () {
                executions++;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                yield* io.update((run) => ({
                  ...changeWorkflowAction(run, id, (action) => ({
                    ...action,
                    state: "completed",
                    phase: "done",
                    commitSha: "published-sha",
                    commands: action.commands.map((command) => ({ ...command, stopped: true })),
                  })),
                }));
              }),
          }),
        ),
      );
      yield* Deferred.await(started);
      const active = (yield* runner.handle(control("status"))).progress!;
      yield* runner.handle(manualRequest(active, "resume"));
      yield* runner.handle(control("status"));
      assert.equal(executions, 1);
      yield* Deferred.succeed(release, undefined);
      yield* h.awaitRun((run) => run.progress.status === "done");
      assert.equal(executions, 1);
    }),
  ),
);

it.effect("Cancel during held recovery retains a late completed action without advancing it", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const seed = yield* seedPublishingRecovery(h, "push", true);
      const savedReceipt = yield* Deferred.make<void>();
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(
          WorkflowActions,
          WorkflowActions.of({
            available: Effect.succeed(true),
            recover: () => Effect.succeed(true),
            execute: (id, io) =>
              Effect.gen(function* () {
                yield* io.update((run) =>
                  changeWorkflowAction(run, id, (action) => ({
                    ...action,
                    state: "completed",
                    phase: "done",
                    commands: action.commands.map((command) => ({ ...command, stopped: true })),
                  })),
                );
                yield* Deferred.succeed(savedReceipt, undefined);
                return yield* Effect.never;
              }),
          }),
        ),
      );
      yield* Deferred.await(savedReceipt);
      yield* Ref.set(h.providerProof, true);
      yield* Ref.update(h.currentThread, (thread) => ({ ...thread!, session: null }));
      yield* runner.handle(control("cancel"));
      const cancelled = yield* h.awaitRun((run) => run.progress.status === "cancelled");
      assert.equal(cancelled.actions!.at(-1)!.state, "completed");
      assert.equal(cancelled.sequence!.cursor, seed.sequence!.cursor);
      assert.isFalse(cancelled.executionReserved);
      assert.equal((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      assert.lengthOf(yield* h.starts, 1);
    }),
  ),
);

const automationOrigin: WorkflowOrigin = {
  kind: "automation",
  organizationId: "org-1",
  repositoryId: "repo-1",
  workflowId: "workflow-1",
  source: {
    provider: "linear",
    applicationId: "app",
    workspaceId: "workspace",
    connectionId: "connection",
    grantId: "grant",
  },
  occurrenceId: "event-1",
};
const automated = (input: WorkflowRequest): WorkflowRequest => {
  const { userId: _userId, ...rest } = input;
  return { ...rest, origin: automationOrigin };
};
it.effect("keeps a manual starter when legacy proofs come from another reviewer", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.complete;
      const review = (yield* runner.handle({ ...control("status"), userId: "bob" })).progress!;
      yield* runner.handle({
        ...checkpointResponse(review, "request_changes", "Please revise"),
        userId: "bob",
      });
      const saved = (yield* (yield* Store.WorkflowRunStore).get("job-1"))!;
      assert.deepStrictEqual(saved.origin, { kind: "manual", userId: "user-1" });
      assert.equal(saved.sequence?.responses[0]?.userId, "bob");
      assert.equal((yield* h.starts).at(-1)?.author?.userId, "user-1");
    }),
  ),
);
it.effect(
  "automation retains its origin through human rework and restart, and rejects takeover",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const baseAccess = yield* RepositoryAccess;
        const permitted = yield* Ref.make(true);
        const access = {
          ...baseAccess,
          requireWorkflowProject: () =>
            Ref.get(permitted).pipe(
              Effect.flatMap((allowed) =>
                allowed
                  ? Effect.void
                  : Effect.fail(
                      new EnvironmentAuthorizationError({
                        message: "removed",
                        requiredScope: "orchestration:read",
                      }),
                    ),
              ),
            ),
        };
        // The fixture checks policy failure through the same typed authorization channel.
        const scoped = yield* Scope.make();
        let runner = yield* h.newRunner.pipe(
          Effect.provideService(RepositoryAccess, access),
          Effect.provideService(Scope.Scope, scoped),
        );
        const start = automated(request());
        assert.equal((yield* runner.handle(start)).protocol, 8);
        assert.equal((yield* runner.handle(start)).protocol, 8);
        assert.lengthOf(yield* h.starts, 1);
        const first = (yield* h.starts)[0]!;
        assert.isUndefined(first.author);
        assert.deepStrictEqual(first.workflowOrigin, {
          kind: "automation",
          jobId: "job-1",
          workflowId: "workflow-1",
          workflowName: workflow.definition.name,
        });
        yield* h.complete;
        const review = (yield* runner.handle(automated(control("status")))).progress!;
        assert.equal(
          (yield* runner.handle(automated(checkpointResponse(review, "request_changes", "revise"))))
            .outcome,
          "conflict",
        );
        yield* runner.handle({
          ...automated(checkpointResponse(review, "request_changes", "revise")),
          requestedBy: "bob",
        });
        const store = yield* Store.WorkflowRunStore;
        assert.equal((yield* store.get("job-1"))?.sequence?.responses[0]?.userId, "bob");
        assert.isUndefined((yield* h.starts).at(-1)?.author);
        const count = (yield* h.starts).length;
        const altered = { ...automationOrigin, occurrenceId: "other" };
        assert.equal(
          (yield* runner.handle({ ...automated(control("status")), origin: altered })).outcome,
          "conflict",
        );
        assert.equal((yield* runner.handle(control("status"))).outcome, "conflict");
        assert.lengthOf(yield* h.starts, count);
        yield* Scope.close(scoped, Exit.void);
        runner = yield* h.newRunner.pipe(Effect.provideService(RepositoryAccess, access));
        assert.deepStrictEqual((yield* store.get("job-1"))?.origin, automationOrigin);
        yield* Ref.set(permitted, false);
        assert.include(
          (yield* runner.handle(automated(control("status")))).progress!.detail!,
          "Repository access",
        );
        assert.lengthOf(yield* h.starts, count);
        const cancelled = yield* runner.handle({
          ...automated(control("cancel")),
          requestedBy: "bob",
        });
        assert.equal(cancelled.progress?.status, "cancelling");
        assert.deepStrictEqual((yield* store.get("job-1"))?.origin, automationOrigin);
      }),
    ),
);

it.effect(
  "legacy cancellation before acceptance remains target-bound across different humans",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        assert.equal(
          (yield* runner.handle({ ...control("cancel"), userId: "bob" })).outcome,
          "cancelled",
        );
        assert.equal((yield* runner.handle(request())).outcome, "cancelled");
        assert.lengthOf(yield* h.starts, 0);
        assert.isUndefined(
          (yield* (yield* Store.WorkflowRunStore).getCancellation("job-1"))?.origin,
        );
      }),
    ),
);
it.effect(
  "automatic cancellation tombstones bind the full origin and remain readable after access removal",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const baseAccess = yield* RepositoryAccess;
        const allowed = yield* Ref.make(true);
        const access = {
          ...baseAccess,
          requireWorkflowProject: () =>
            Ref.get(allowed).pipe(
              Effect.flatMap((ready) =>
                ready
                  ? Effect.void
                  : Effect.fail(
                      new EnvironmentAuthorizationError({
                        message: "removed",
                        requiredScope: "orchestration:read",
                      }),
                    ),
              ),
            ),
        };
        const runner = yield* h.newRunner.pipe(Effect.provideService(RepositoryAccess, access));
        assert.equal(
          (yield* runner.handle({ ...automated(control("cancel")), requestedBy: "bob" })).outcome,
          "cancelled",
        );
        yield* Ref.set(allowed, false);
        assert.equal((yield* runner.handle(automated(control("status")))).outcome, "cancelled");
        assert.equal(
          (yield* runner.handle({
            ...automated(request()),
            origin: { ...automationOrigin, occurrenceId: "other" },
          })).outcome,
          "conflict",
        );
        assert.equal((yield* runner.handle(request())).outcome, "conflict");
        assert.lengthOf(yield* h.starts, 0);
      }),
    ),
);

const legacyWorkflowResult = WorkflowControlResult.mapFields((fields) => ({
  ...fields,
  protocol: Schema.Literals([1, 2, 3, 4, 5, 6, 7]),
}));
const decodeLegacyWorkflowResult = Schema.decodeUnknownSync(legacyWorkflowResult);
const automationAccess = Effect.gen(function* () {
  const base = yield* RepositoryAccess;
  const allowed = yield* Ref.make(true);
  return {
    allowed,
    service: {
      ...base,
      requireWorkflowProject: () =>
        Ref.get(allowed).pipe(
          Effect.flatMap((ok) =>
            ok
              ? Effect.void
              : Effect.fail(
                  new EnvironmentAuthorizationError({
                    message: "removed",
                    requiredScope: "orchestration:read",
                  }),
                ),
          ),
        ),
    },
  };
});
it.effect("releases capacity after automation completion despite repository access removal", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const access = yield* automationAccess;
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, access.service),
      );
      yield* runner.handle(automated(request()));
      yield* Ref.set(access.allowed, false);
      yield* h.complete;
      const review = (yield* runner.handle(automated(control("status")))).progress!;
      const store = yield* Store.WorkflowRunStore;
      assert.equal(review.status, "awaiting_review");
      assert.isNotNull(review.checkpoint);
      assert.isFalse(yield* store.isExecuting());
      const revision = review.revision;
      assert.equal(
        (yield* runner.handle(automated(control("status")))).progress?.revision,
        revision,
      );
      assert.equal((yield* runner.handle(request("other-job"))).outcome, "accepted");
      assert.lengthOf(yield* h.starts, 2);
    }),
  ),
);
it.effect.each([false, true])(
  "legacy manual responses remain decodable with publishing=%s",
  (publishing) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner.pipe(
          Effect.provideService(WorkflowActions, {
            available: Effect.succeed(publishing),
            recover: () => Effect.succeed(true),
            execute: () => Effect.void,
          }),
        );
        const check = (response: WorkflowControlResult) =>
          assert.equal(decodeLegacyWorkflowResult(response).protocol, publishing ? 7 : 6);
        check(yield* runner.handle(control("status")));
        check(yield* runner.handle(request()));
        yield* h.complete;
        const review = yield* runner.handle({ ...control("status"), userId: "bob" });
        check(review);
        check(
          yield* runner.handle({
            ...checkpointResponse(review.progress!, "request_changes", "revise"),
            userId: "bob",
          }),
        );
        assert.equal(
          (yield* runner.handle({
            ...control("status"),
            origin: { kind: "manual", userId: "user-1" },
          })).protocol,
          8,
        );
        check(yield* runner.handle(control("cancel")));
      }),
    ),
);
it.effect("cancels an unaccepted automation after access removal and fences a delayed Start", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const access = yield* automationAccess;
      yield* Ref.set(access.allowed, false);
      const scope = yield* Scope.make();
      let runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, access.service),
        Effect.provideService(Scope.Scope, scope),
      );
      const cancel = { ...automated(control("cancel")), requestedBy: "bob" };
      assert.equal((yield* runner.handle(cancel)).outcome, "cancelled");
      assert.equal((yield* runner.handle(automated(control("status")))).outcome, "cancelled");
      yield* Scope.close(scope, Exit.void);
      runner = yield* h.newRunner.pipe(Effect.provideService(RepositoryAccess, access.service));
      assert.equal((yield* runner.handle(cancel)).outcome, "cancelled");
      yield* Ref.set(access.allowed, true);
      assert.equal((yield* runner.handle(automated(request()))).outcome, "cancelled");
      const store = yield* Store.WorkflowRunStore;
      assert.deepEqual((yield* store.getCancellation("job-1"))?.origin, automationOrigin);
      assert.isFalse(yield* store.isExecuting());
      assert.lengthOf(yield* h.starts, 0);
    }),
  ),
);

const completionEvent = (threadId: ThreadId): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make("completion-event"),
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
      id: EventId.make("completion-evidence"),
      kind: "workflow.progress",
      tone: "info",
      summary: "Completed",
      payload: {},
      turnId: null,
      createdAt: NOW,
    },
  },
});
it.effect.each(["status", "event", "restart"] as const)(
  "reconciles automation evidence and resumes a blocked successor via %s",
  (mode) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const access = yield* automationAccess;
        const scope = yield* Scope.make();
        let runner = yield* h.newRunner.pipe(
          Effect.provideService(RepositoryAccess, access.service),
          Effect.provideService(Scope.Scope, scope),
        );
        const original = automated(request());
        yield* runner.handle({
          ...original,
          control: {
            ...original.control,
            operation: "start",
            workflow: {
              ...workflow,
              definition: {
                ...workflow.definition,
                steps: [
                  workflow.definition.steps[0]!,
                  { ...workflow.definition.steps[0]!, id: "next-agent" },
                  workflow.definition.steps[1]!,
                ],
              },
            },
          },
        });
        yield* Ref.set(access.allowed, false);
        yield* h.complete;
        if (mode === "event") {
          yield* h.emit(completionEvent(ThreadId.make("workflow:job-1:agent")));
          yield* h.awaitRun((run) => run.sequence?.cursor === 1 && !run.executionReserved);
        } else if (mode === "restart") {
          yield* Scope.close(scope, Exit.void);
          runner = yield* h.newRunner.pipe(Effect.provideService(RepositoryAccess, access.service));
        }
        const waiting = (yield* runner.handle(automated(control("status")))).progress!;
        const store = yield* Store.WorkflowRunStore;
        assert.equal(waiting.status, "waiting_capacity");
        assert.include(waiting.detail!, "Repository access");
        assert.isFalse((yield* store.get("job-1"))!.executionReserved);
        assert.lengthOf(yield* h.starts, 1);
        assert.equal(
          (yield* runner.handle(automated(control("status")))).progress?.revision,
          waiting.revision,
        );
        yield* Ref.set(access.allowed, true);
        yield* runner.handle(automated(control("status")));
        yield* runner.handle(automated(control("status")));
        assert.lengthOf(yield* h.starts, 2);
        assert.deepEqual((yield* store.get("job-1"))?.origin, automationOrigin);
        assert.equal((yield* store.get("job-1"))?.sequence?.generation, 0);
        assert.isNull((yield* store.get("job-1"))?.progress.detail);
      }),
    ),
);
it.effect("access loss retains incomplete prompt ownership and actionable failures", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const access = yield* automationAccess;
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, access.service),
      );
      yield* runner.handle(automated(request()));
      yield* Ref.set(access.allowed, false);
      yield* runner.handle(automated(control("status")));
      const store = yield* Store.WorkflowRunStore;
      assert.isTrue(yield* store.isExecuting());
      yield* store.save({
        ...(yield* store.get("job-1"))!,
        progress: {
          ...(yield* store.get("job-1"))!.progress,
          status: "paused",
          detail: "Original provider failure",
        },
      });
      assert.equal(
        (yield* runner.handle(automated(control("status")))).progress?.detail,
        "Original provider failure",
      );
      yield* Ref.set(access.allowed, true);
      assert.equal(
        (yield* runner.handle(automated(control("status")))).progress?.detail,
        "Original provider failure",
      );
      assert.isTrue(yield* store.isExecuting());
    }),
  ),
);
it.effect("settles recorded approval cleanup after repository access removal", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const access = yield* automationAccess;
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, access.service),
      );
      yield* runner.handle(automated(request()));
      yield* h.complete;
      yield* withBackground(h);
      const review = (yield* runner.handle(automated(control("status")))).progress!;
      yield* runner.handle({ ...automated(approve(review)), requestedBy: "bob" });
      yield* Queue.take(h.cleanups);
      yield* Ref.set(access.allowed, false);
      yield* Queue.offer(h.cleanupOutcomes, null);
      const done = yield* h.awaitRun((run) => run.progress.status === "done");
      assert.equal(done.approvedBy, "bob");
      assert.isFalse(done.executionReserved);
      assert.isNull(done.approvalAttempt);
      assert.lengthOf(yield* h.starts, 1);
      assert.equal(yield* Queue.size(h.cleanups), 0);
    }),
  ),
);
it.effect("completed publishing releases capacity while access blocks its successor", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const access = yield* automationAccess;
      const began = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const ids: string[] = [];
      const actions = {
        available: Effect.succeed(true),
        recover: () => Effect.succeed(true),
        execute: (id: string, io: WorkflowActionIO) =>
          Effect.gen(function* () {
            ids.push(id);
            yield* Deferred.succeed(began, undefined);
            yield* Deferred.await(finish);
            yield* io.update((run) => ({
              ...changeWorkflowAction(run, id, (action) => ({
                ...action,
                state: "completed",
                phase: "done",
                commitSha: "published-sha",
              })),
              preparedHead: "published-sha",
            }));
          }),
      };
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, access.service),
        Effect.provideService(WorkflowActions, actions),
      );
      const original = automated(request());
      yield* runner.handle({
        ...original,
        control: {
          ...original.control,
          operation: "start",
          workflow: {
            ...workflow,
            definition: {
              ...workflow.definition,
              steps: [
                ...workflow.definition.steps,
                { id: "push", kind: "action", title: "Push", action: "push" },
                { ...workflow.definition.steps[0]!, id: "last-agent" },
              ],
            },
          },
        },
      });
      yield* h.complete;
      const review = (yield* runner.handle(automated(control("status")))).progress!;
      yield* runner.handle({ ...automated(approve(review)), requestedBy: "bob" });
      yield* Deferred.await(began);
      yield* Ref.set(access.allowed, false);
      yield* Deferred.succeed(finish, undefined);
      const waiting = yield* h.awaitRun(
        (run) => run.sequence?.cursor === 3 && !run.executionReserved,
      );
      assert.equal(waiting.actions?.[0]?.state, "completed");
      assert.lengthOf(ids, 1);
      assert.lengthOf(yield* h.starts, 1);
      assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
      yield* Ref.set(access.allowed, true);
      yield* runner.handle(automated(control("status")));
      assert.lengthOf(ids, 1);
      assert.lengthOf(yield* h.starts, 2);
    }),
  ),
);
it.effect.each([
  "origin",
  "source",
  "grant",
  "workflow",
  "organization",
  "repository",
  "project",
  "canonical",
] as const)("automation tombstone rejects changed %s", (changed) =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const access = yield* automationAccess;
      yield* Ref.set(access.allowed, false);
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, access.service),
      );
      const cancel = { ...automated(control("cancel")), requestedBy: "bob" };
      assert.equal((yield* runner.handle(cancel)).outcome, "cancelled");
      const altered: WorkflowRequest = {
        ...cancel,
        origin:
          changed === "origin"
            ? { ...automationOrigin, occurrenceId: "different" }
            : changed === "source"
              ? {
                  ...automationOrigin,
                  source: { ...automationOrigin.source, connectionId: "different" },
                }
              : changed === "grant"
                ? {
                    ...automationOrigin,
                    source: { ...automationOrigin.source, grantId: "different" },
                  }
                : changed === "workflow"
                  ? { ...automationOrigin, workflowId: "different" }
                  : automationOrigin,
        repositoryCanonicalKey:
          changed === "canonical" ? "github.com/other/repo" : cancel.repositoryCanonicalKey,
        control: {
          ...cancel.control,
          ...(changed === "organization" ? { organizationId: "other" } : {}),
          ...(changed === "repository" ? { repositoryId: "other" } : {}),
          ...(changed === "project" ? { projectId: (PROJECT + "-other") as typeof PROJECT } : {}),
        },
      };
      assert.equal((yield* runner.handle(altered)).outcome, "conflict");
      assert.deepEqual(
        (yield* (yield* Store.WorkflowRunStore).getCancellation("job-1"))?.origin,
        automationOrigin,
      );
      assert.lengthOf(yield* h.starts, 0);
    }),
  ),
);
