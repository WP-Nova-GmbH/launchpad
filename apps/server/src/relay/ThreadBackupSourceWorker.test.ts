import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmBackupSource } from "@t3tools/contracts/relay";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { VmControlSpawner, VmWorkloadTracking } from "../vmWorkloadCommand.ts";
import { makeThreadBackupSourceWorker } from "./ThreadBackupSourceWorker.ts";
import { ThreadBackupSourceError } from "./ThreadBackupSourceTransport.ts";
import { threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import {
  attachmentCheckpointFixture,
  runAttachmentCheckpointTest,
} from "./testUtils/threadAttachmentCheckpoint.ts";

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
for (const problem of [
  "lost-freeze-reply",
  "queued-work",
  "late-queued-work",
  "busy-terminal",
  "foreign-freeze",
  "foreign-cancel",
  "foreign-activation",
  "untracked",
] as const) {
  it.effect(`periodic VM backup preserves its stopped source through ${problem}`, () =>
    runAttachmentCheckpointTest(
      Effect.gen(function* () {
        const f = yield* attachmentCheckpointFixture,
          operationId = NodeCrypto.randomUUID(),
          bootId = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at) VALUES(${f.owner.threadId},'codex','codex','stopped','2026-10-07T00:00:00Z')`;
        yield* f.sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,completed_at,checkpoint_files_json) VALUES(${f.owner.threadId},${f.nativeInput.turnId},'completed','2026-10-07T00:00:00Z','2026-10-07T00:01:00Z','[]')`;
        let backup: RelayThreadVmBackupSource = {
          threadId: ThreadId.make(f.owner.threadId),
          environmentId: EnvironmentId.make(f.owner.environmentId),
          generation: 1,
          operationId,
          phase: "pending",
          nativeCheckpointOperationId: null,
          canActivate: false,
          sourceReopened: false,
        };
        let captures = 0,
          freezes = 0,
          cancellations = 0,
          activations = 0,
          closes = 0,
          epoch = 0,
          sealedBy: string | null = null,
          reopens = 0;
        const queued = encode({
          ...emptyThreadPromptQueue(),
          entries: [
            {
              kind: "move",
              messageId: "queued",
              destination: { kind: "vm" },
              state: "pending",
              revision: 0,
              acceptedSequence: 1,
              createdAt: "2026-10-07T00:00:00Z",
            },
          ],
        });
        const enqueue = f.sql`INSERT INTO projection_thread_prompt_queues(thread_id,state_json) VALUES(${f.owner.threadId},${queued})`;
        if (problem === "queued-work" || problem === "foreign-cancel") yield* enqueue;
        const control = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand")
            return Effect.die("Expected one VM control request");
          if (command.args[0] === "seal") {
            if (sealedBy === null) epoch++;
            sealedBy = command.args[2]!;
          }
          if (command.args[0] === "reopen") {
            expect(command.args[2]).toBe(sealedBy);
            sealedBy = null;
            epoch++;
            reopens++;
          }
          const busy = problem === "busy-terminal";
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(
                Stream.make(
                  encode({
                    bootId,
                    epoch,
                    sealedBy,
                    groups: busy
                      ? [{ id: "a".repeat(32), bootId, kind: "terminal", leaderPid: 2 }]
                      : [],
                    stopped: !busy,
                  }),
                ),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const services = Layer.mergeAll(
          Layer.mock(ProviderService)({
            listSessions: () => Effect.succeed([]),
            stopSession: () => Effect.void,
            stopIdleVmSession: () => Effect.succeed(false),
            flushRuntimeEvents: () => Effect.void,
            checkpointConversation: () =>
              Effect.gen(function* () {
                yield* f.native.captureFrozen({ ...f.nativeInput, operationId }, (stage) =>
                  Effect.gen(function* () {
                    captures++;
                    const directory = f.path.join(stage, "conversation");
                    yield* f.fs.copy(f.point.directory, directory);
                    return { directory, nativeThreadId: f.point.nativeThreadId };
                  }),
                );
                yield* f.store.capture({ ...f.input, captureOperationId: operationId });
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, f.fs),
                Effect.provideService(Path.Path, f.path),
                Effect.orDie,
              ),
          }),
          Layer.mock(TerminalManager)({
            close: () =>
              Effect.gen(function* () {
                closes++;
                if (problem === "late-queued-work") yield* enqueue;
              }).pipe(Effect.orDie),
          }),
          Layer.mock(OrchestrationEngineService)({}),
        );
        const worker = yield* makeThreadBackupSourceWorker(
          {
            get: () => Effect.succeed(backup),
            freeze: (_owner, input) =>
              Effect.gen(function* () {
                freezes++;
                expect(input.bootId).toBe(bootId);
                expect(input.sealEpoch).toBe(epoch);
                expect(sealedBy).toBe(
                  NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32),
                );
                backup = {
                  ...backup,
                  phase: "creating",
                  nativeCheckpointOperationId: input.nativeCheckpointOperationId,
                };
                if (problem === "lost-freeze-reply")
                  return yield* new ThreadBackupSourceError({
                    threadId: f.owner.threadId,
                    detail: "Lost reply",
                  });
                return problem === "foreign-freeze" ? { ...backup, generation: 2 } : backup;
              }),
            cancel: () =>
              Effect.sync(() => {
                cancellations++;
                backup = { ...backup, phase: "failed", canActivate: true };
                return problem === "foreign-cancel" ? { ...backup, generation: 2 } : backup;
              }),
            activate: () =>
              Effect.gen(function* () {
                activations++;
                expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
                backup = { ...backup, sourceReopened: true };
                return problem === "foreign-activation" ? { ...backup, generation: 2 } : backup;
              }).pipe(Effect.orDie),
          },
          { synchronize: () => Effect.succeed(undefined) },
          {
            synchronize: () =>
              Effect.gen(function* () {
                const key = threadCheckpointId(f.nativeInput.turnId, operationId);
                yield* f.sql`UPDATE thread_native_checkpoints SET published_artifact_id='native-publication' WHERE thread_id=${f.owner.threadId} AND checkpoint_id=${key}`;
                yield* f.sql`UPDATE thread_attachment_checkpoints SET published_artifact_id='attachment-publication' WHERE thread_id=${f.owner.threadId} AND checkpoint_id=${key}`;
              }).pipe(Effect.orDie),
          },
        ).pipe(
          Effect.provide(services),
          Effect.provideService(VmWorkloadTracking, problem !== "untracked"),
          Effect.provideService(VmControlSpawner, control),
        );
        const sync = worker
          .synchronize(f.owner.threadId)
          .pipe(Effect.provideService(VmControlSpawner, control));
        const first = yield* sync.pipe(Effect.result);
        if (problem === "untracked") {
          expect(first._tag).toBe("Failure");
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect(captures).toBe(0);
          return;
        }
        if (problem === "busy-terminal") {
          expect(first._tag).toBe("Success");
          expect(closes).toBe(0);
          expect(captures).toBe(0);
          expect(freezes).toBe(0);
          return;
        }
        if (
          problem === "queued-work" ||
          problem === "late-queued-work" ||
          problem === "foreign-cancel"
        ) {
          expect(first._tag).toBe(problem === "foreign-cancel" ? "Failure" : "Success");
          expect(cancellations).toBe(1);
          expect(captures).toBe(0);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
          yield* sync;
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect(activations).toBe(1);
          expect(reopens).toBe(problem === "late-queued-work" ? 1 : 0);
          return;
        }
        expect(first._tag).toBe(
          problem === "lost-freeze-reply" || problem === "foreign-freeze" ? "Failure" : "Success",
        );
        expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
        expect(captures).toBe(1);
        expect(freezes).toBe(1);
        yield* sync;
        expect(captures).toBe(1);
        expect(freezes).toBe(1);
        expect(reopens).toBe(0);
        backup = { ...backup, phase: "verified", canActivate: true };
        const activated = yield* sync.pipe(Effect.result);
        expect(activated._tag).toBe(problem === "foreign-activation" ? "Failure" : "Success");
        expect(reopens).toBe(1);
        expect(activations).toBe(1);
        expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
        const point = yield* f.native.get(
          f.owner.threadId,
          1,
          threadCheckpointId(f.nativeInput.turnId, operationId),
        );
        expect(point?.publishedArtifactId).toBe("native-publication");
        expect(yield* f.fs.exists(point!.directory)).toBe(true);
        yield* sync;
        expect(activations).toBe(1);
        expect(reopens).toBe(1);
      }),
    ),
  );
}
