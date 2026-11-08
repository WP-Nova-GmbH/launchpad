import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { WorkflowRun } from "../jobs/WorkflowRunStore.ts";
import { WorkflowVmDispatchBinding } from "@t3tools/contracts/workflows";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { VmSealedWorkloadAdmission, withVmWorkloads } from "../vmWorkloadCommand.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import {
  adoptWorkflowVmCancellationSeal,
  withWorkflowVmCancelledCheckpointRead,
  workflowVmCancellationSeal,
  type WorkflowVmCancellationProof,
} from "./WorkflowVmCancellation.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRun = Schema.decodeUnknownSync(WorkflowRun);
const decodeBinding = Schema.decodeUnknownSync(WorkflowVmDispatchBinding);
const hash = (operation: string) =>
  NodeCrypto.createHash("sha256").update(operation).digest("hex").slice(0, 32);
const proof: WorkflowVmCancellationProof = {
  jobId: "job",
  threadId: "thread",
  environmentId: "environment",
  allocationId: "allocation",
  generation: 1,
  operationId: "enroll",
  cancellationId: "cancel",
  runtimeEpisode: "episode",
  continuationKey: "codex:instance:codex",
  providerInstanceId: "codex",
  bootId: "cb7c9212-2128-478f-9d11-6e4c8ed6f882",
  epoch: 1,
};
const input = {
  threadId: "thread",
  environmentId: "environment",
  generation: 1,
  operationId: "final-save",
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-10-12T10:00:00.000Z";
  const runtime = {
    kind: "vm",
    jobId: "job",
    threadId: "thread",
    organizationId: "org",
    repositoryId: "repo",
    allocationId: "allocation",
    environmentId: "environment",
    generation: 1,
    operationId: "enroll",
    projectId: "project",
  };
  const run = decodeRun({
    jobId: "job",
    userId: "owner",
    repositoryCanonicalKey: "github.com/acme/repo",
    instruction: "Work",
    modelSelection: { instanceId: "codex", model: "gpt-test" },
    providerContinuation: { driver: "codex", continuationKey: proof.continuationKey },
    baseBranch: "main",
    baseSha: "base",
    createdAt: now,
    promptDispatched: true,
    executionReserved: false,
    cancellationAttempt: null,
    worktreePath: null,
    preparedHead: null,
    approvedBy: null,
    runtime,
    workflow: {
      workflowId: "workflow",
      organizationId: "org",
      repositoryId: "repo",
      revision: 1,
      archived: false,
      createdAt: now,
      updatedAt: now,
      definition: {
        name: "Workflow",
        target: { kind: "vm", baseBranch: null },
        steps: [
          { id: "agent", kind: "agent", title: "Work", instruction: "Work", modelSelection: null },
        ],
      },
    },
    progress: {
      revision: 3,
      status: "cancelled",
      threadId: "thread",
      detail: null,
      checkpoint: null,
    },
  });
  yield* sql`INSERT INTO repository_workflow_jobs VALUES ('job','thread','cancelled',0,${json(run)})`;
  yield* sql`INSERT INTO thread_execution_fences(thread_id,relay_url,environment_id,project_id,generation,operation_id,phase) VALUES('thread','https://relay.test','environment','project',1,'final-save','draining')`;
  yield* sql`INSERT INTO provider_session_runtime(thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at,runtime_payload_json) VALUES('thread','codex','codex','codex','stopped',${now},${json({ workflowVmCancellation: proof, providerContinuation: { workflowJobId: "job", continuationKey: proof.continuationKey, runtimeEpisode: proof.runtimeEpisode, shutdownConfirmed: true, shutdownEvidenceVersion: 2 } })})`;
  const kernel = {
    bootId: proof.bootId,
    epoch: proof.epoch,
    sealedBy: workflowVmCancellationSeal(proof) as string | null,
    groups: [] as Array<{ id: string; bootId: string; kind: string; leaderPid: number }>,
    failSeal: false,
    actions: [] as string[],
  };
  const spawner = ChildProcessSpawner.make(
    Effect.fnUntraced(function* (command) {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("unexpected pipeline");
      const [action, , operation] = command.args;
      kernel.actions.push(action!);
      let code = 0;
      if (action === "reopen") {
        assert.equal(kernel.sealedBy, operation);
        kernel.sealedBy = null;
        kernel.epoch++;
      }
      if (action === "seal") {
        if (kernel.failSeal) {
          code = 74;
          kernel.failSeal = false;
        } else {
          assert.isNull(kernel.sealedBy);
          kernel.sealedBy = operation!;
          kernel.epoch++;
        }
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(
          Stream.make(
            json({
              bootId: kernel.bootId,
              epoch: kernel.epoch,
              sealedBy: kernel.sealedBy,
              groups: kernel.groups,
              stopped: kernel.groups.length === 0,
            }),
          ),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const adopt = adoptWorkflowVmCancellationSeal(sql, input).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  return { sql, run, kernel, adopt, spawner };
});

it.effect("hands a completed cancellation seal to final save and replays a partial handoff", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.kernel.failSeal = true;
    yield* Effect.flip(f.adopt);
    assert.isNull(f.kernel.sealedBy);
    assert.equal(f.kernel.epoch, 2);
    yield* f.adopt;
    assert.equal(f.kernel.sealedBy, hash(input.operationId));
    assert.equal(f.kernel.epoch, 3);
    const count = f.kernel.actions.length;
    yield* f.adopt;
    assert.equal(f.kernel.actions.length, count);
    const [row] = yield* f.sql<{
      pending: unknown;
    }>`SELECT json_extract(runtime_payload_json,'$.workflowVmCancellation') AS pending FROM provider_session_runtime`;
    assert.isNull(row!.pending);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

for (const changed of ["ownership", "generation", "episode", "boot", "epoch", "survivor"] as const)
  it.effect(`does not adopt a cancelled VM seal after changed ${changed}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (changed === "ownership")
        yield* f.sql`UPDATE repository_workflow_jobs SET record_json=${json({ ...f.run, executionReserved: true })}`;
      if (changed === "generation") yield* f.sql`UPDATE thread_execution_fences SET generation=2`;
      if (changed === "episode")
        yield* f.sql`UPDATE provider_session_runtime SET runtime_payload_json=json_set(runtime_payload_json,'$.providerContinuation.runtimeEpisode','replacement')`;
      if (changed === "boot") f.kernel.bootId = "ab7c9212-2128-478f-9d11-6e4c8ed6f882";
      if (changed === "epoch") f.kernel.epoch++;
      if (changed === "survivor")
        f.kernel.groups.push({
          id: "a".repeat(32),
          bootId: proof.bootId,
          kind: "process",
          leaderPid: 123,
        });
      yield* Effect.flip(f.adopt);
      assert.equal(f.kernel.sealedBy, workflowVmCancellationSeal(proof));
      assert.isFalse(f.kernel.actions.includes("reopen"));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

const readFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const binding = decodeBinding(f.run.runtime);
  yield* f.sql`UPDATE thread_execution_fences SET phase='active',operation_id='enroll'`;
  yield* f.sql`UPDATE provider_session_runtime SET runtime_payload_json=json_set(
    runtime_payload_json,'$.stoppedRuntimeEventsDrained',json('true'))`;
  const installed = {
    operationId: binding.operationId,
    scope: {
      allocationId: binding.allocationId,
      threadId: binding.threadId,
      repositoryId: binding.repositoryId,
      generation: binding.generation,
    },
    relayUrl: "https://relay.test",
    relayIssuer: "https://relay.test",
    environmentId: binding.environmentId,
    environmentCredential: "test-credential",
    cloudMintPublicKey: "test-mint-key",
  };
  const secrets = ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        assert.equal(name, THREAD_VM_IDENTITY_SECRET);
        return Option.some(new TextEncoder().encode(json(installed)));
      }),
    set: () => Effect.die("Read must not write secrets"),
    create: () => Effect.die("Read must not create secrets"),
    getOrCreateRandom: () => Effect.die("Read must not create credentials"),
    remove: () => Effect.die("Read must not remove secrets"),
  });
  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withWorkflowVmCancelledCheckpointRead(f.sql, binding, effect);
  const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withVmWorkloads(effect, true).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
      Effect.provideService(ServerSecretStore, secrets),
    );
  return { ...f, binding, installed, read, tracked };
});

it.effect(
  "reads a cancelled checkpoint using its durable proof after the attempt was cleared",
  () =>
    Effect.gen(function* () {
      const f = yield* readFixture;
      assert.isNull(f.run.cancellationAttempt);
      const before = json(f.run);
      const value = yield* f.tracked(
        f.read(
          Effect.gen(function* () {
            const admission = yield* VmSealedWorkloadAdmission;
            assert.deepEqual(admission, {
              bootId: proof.bootId,
              operationId: workflowVmCancellationSeal(proof),
              epoch: proof.epoch,
            });
            return "saved patch";
          }),
        ),
      );
      assert.equal(value, "saved patch");
      assert.equal(f.kernel.sealedBy, workflowVmCancellationSeal(proof));
      assert.equal(f.kernel.epoch, proof.epoch);
      assert.deepEqual(f.kernel.actions, ["inspect", "inspect"]);
      const [row] = yield* f.sql<{
        record: string;
      }>`SELECT record_json AS record FROM repository_workflow_jobs`;
      assert.equal(row!.record, before);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("preserves an ordinary unsealed read after recovery removed the cancellation proof", () =>
  Effect.gen(function* () {
    const f = yield* readFixture;
    yield* f.sql`UPDATE provider_session_runtime SET runtime_payload_json=json_remove(
      runtime_payload_json,'$.workflowVmCancellation')`;
    f.kernel.sealedBy = null;
    const value = yield* f.tracked(
      f.read(
        Effect.map(VmSealedWorkloadAdmission, (admission) => {
          assert.isUndefined(admission);
          return "ordinary patch";
        }),
      ),
    );
    assert.equal(value, "ordinary patch");
    assert.deepEqual(f.kernel.actions, []);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

for (const changed of [
  "unfinished cancellation",
  "undrained output",
  "provider episode",
  "malformed proof",
  "draining owner",
  "installed generation",
  "boot",
  "epoch",
  "seal",
] as const)
  it.effect(`refuses cancelled checkpoint admission for ${changed}`, () =>
    Effect.gen(function* () {
      const f = yield* readFixture;
      if (changed === "unfinished cancellation")
        yield* f.sql`UPDATE repository_workflow_jobs SET record_json=${json({
          ...f.run,
          cancellationAttempt: { commandId: "pending", createdAt: f.run.createdAt },
        })}`;
      if (changed === "undrained output")
        yield* f.sql`UPDATE provider_session_runtime SET runtime_payload_json=json_set(
          runtime_payload_json,'$.stoppedRuntimeEventsDrained',json('false'))`;
      if (changed === "provider episode")
        yield* f.sql`UPDATE provider_session_runtime SET runtime_payload_json=json_set(
          runtime_payload_json,'$.providerContinuation.runtimeEpisode','replacement')`;
      if (changed === "malformed proof")
        yield* f.sql`UPDATE provider_session_runtime SET runtime_payload_json=json_set(
          runtime_payload_json,'$.workflowVmCancellation',json('null'))`;
      if (changed === "draining owner")
        yield* f.sql`UPDATE thread_execution_fences SET phase='draining'`;
      if (changed === "installed generation") f.installed.scope.generation++;
      if (changed === "boot") f.kernel.bootId = "ab7c9212-2128-478f-9d11-6e4c8ed6f882";
      if (changed === "epoch") f.kernel.epoch++;
      if (changed === "seal") f.kernel.sealedBy = hash("another-operation");
      let read = false;
      yield* Effect.flip(
        f.tracked(
          f.read(
            Effect.sync(() => {
              read = true;
            }),
          ),
        ),
      );
      assert.isFalse(read);
      assert.isFalse(f.kernel.actions.includes("reopen"));
      assert.isFalse(f.kernel.actions.includes("seal"));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

it.effect("rejects a patch when durable ownership changes during its read", () =>
  Effect.gen(function* () {
    const f = yield* readFixture;
    yield* Effect.flip(
      f.tracked(
        f.read(
          Effect.gen(function* () {
            yield* f.sql`UPDATE thread_execution_fences SET phase='draining'`;
            return "must not be returned";
          }),
        ),
      ),
    );
    assert.equal(f.kernel.sealedBy, workflowVmCancellationSeal(proof));
    assert.equal(f.kernel.epoch, proof.epoch);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("serializes cancelled checkpoint reads through the shared maintenance admission", () =>
  Effect.gen(function* () {
    const f = yield* readFixture;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const events: string[] = [];
    yield* f.tracked(
      Effect.gen(function* () {
        const first = yield* f
          .read(
            Effect.gen(function* () {
              events.push("first entered");
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              events.push("first done");
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const second = yield* f
          .read(
            Effect.sync(() => {
              events.push("second entered");
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
    assert.deepEqual(events, ["first entered", "first done", "second entered"]);
    assert.equal(f.kernel.sealedBy, workflowVmCancellationSeal(proof));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "finishes a queued final-save adoption after rejecting a read whose source began draining",
  () =>
    Effect.gen(function* () {
      const f = yield* readFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* f.tracked(
        Effect.gen(function* () {
          const read = yield* f
            .read(
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return "stale patch";
              }),
            )
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* f.sql`UPDATE thread_execution_fences SET phase='draining',operation_id='final-save'`;
          const adoption = yield* f.adopt.pipe(Effect.forkChild);
          yield* Deferred.succeed(release, undefined);
          const outcome = yield* Fiber.join(read);
          assert.equal(outcome._tag, "Failure");
          if (outcome._tag === "Failure")
            assert.equal(outcome.failure._tag, "ThreadExecutionFenceError");
          yield* Fiber.join(adoption);
        }),
      );
      assert.deepEqual(f.kernel.actions, ["inspect", "inspect", "inspect", "reopen", "seal"]);
      assert.equal(f.kernel.sealedBy, hash(input.operationId));
      assert.equal(f.kernel.epoch, proof.epoch + 2);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
