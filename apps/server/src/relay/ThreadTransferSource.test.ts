import * as NodeCrypto from "node:crypto";
import { ThreadPromptQueue } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeThreadTransferSource } from "./ThreadTransferSource.ts";
import { threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import {
  attachmentCheckpointFixture,
  runAttachmentCheckpointTest,
} from "./testUtils/threadAttachmentCheckpoint.ts";

const encodeQueue = Schema.encodeUnknownSync(Schema.fromJsonString(ThreadPromptQueue));
const fixture = Effect.gen(function* () {
  const f = yield* attachmentCheckpointFixture;
  const operationId = NodeCrypto.randomUUID(),
    input = { ...f.owner, operationId };
  yield* f.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at)
    VALUES(${f.owner.threadId},'codex','codex','stopped','2026-10-07T01:00:00Z')`;
  yield* f.sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,completed_at,checkpoint_files_json)
    VALUES(${f.owner.threadId},${f.nativeInput.turnId},'completed','2026-10-07T01:00:00Z','2026-10-07T01:01:00Z','[]')`;
  yield* f.fences.beginDrain({ ...input, previousOperationId: f.owner.operationId });
  let captures = 0;
  const capture = Effect.gen(function* () {
    captures++;
    yield* f.native.captureFrozen({ ...f.nativeInput, operationId }, (stage) =>
      Effect.gen(function* () {
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
  );
  const provider = {
    listSessions: () => Effect.succeed([]),
    checkpointConversation: () => capture,
  };
  const source = makeThreadTransferSource(f.sql, f.events, provider);
  return { ...f, input, provider, source, captures: () => captures };
});
it.effect("freezes and retains matching native/chat checkpoints before a source archive", () =>
  runAttachmentCheckpointTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message(f.attachments[2]!);
      const source = yield* f.source.freeze(f.input);
      expect(source.nativeCheckpointTurnId).toBe(f.nativeInput.turnId);
      expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
      const key = threadCheckpointId(f.nativeInput.turnId, f.input.operationId);
      expect((yield* f.native.get(f.owner.threadId, 1, key))?.sourceSequence).toBe(
        source.sourceSequence,
      );
      expect((yield* f.store.get(f.owner.threadId, 1, key))?.sourceSequence).toBe(
        source.sourceSequence,
      );
      expect(yield* f.source.freeze(f.input)).toEqual(source);
      expect(
        (yield* f.native.get(f.owner.threadId, 1, f.nativeInput.turnId))?.captureOperationId,
      ).toBeNull();
      expect(
        yield* Effect.flip(
          f.fences.beginWork({
            threadId: f.owner.threadId,
            generation: 1,
            kind: "provider",
            workId: "after-freeze",
          }),
        ),
      ).toMatchObject({ _tag: "ThreadExecutionFenceError" });
    }),
  ),
);
for (const problem of [
  "running-turn",
  "unacknowledged-completion",
  "running-provider",
  "missing-settled-turn",
  "wrong-owner",
  "queue-handoff",
  "awaiting-turn",
  "pending-checkpoint",
] as const) {
  it.effect(`does not freeze while source has ${problem}`, () =>
    runAttachmentCheckpointTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        if (problem === "running-turn")
          yield* f.sql`UPDATE projection_turns SET state='running',completed_at=NULL WHERE thread_id=${f.owner.threadId}`;
        if (problem === "unacknowledged-completion")
          yield* f.sql`INSERT INTO thread_execution_work(thread_id,work_id,generation,kind,started,completed,relay_completed) VALUES(${f.owner.threadId},'unacknowledged',1,'provider',1,1,0)`;
        if (problem === "running-provider")
          yield* f.sql`UPDATE provider_session_runtime SET status='running' WHERE thread_id=${f.owner.threadId}`;
        if (problem === "missing-settled-turn")
          yield* f.sql`DELETE FROM projection_turns WHERE thread_id=${f.owner.threadId}`;
        if (problem === "pending-checkpoint")
          yield* f.sql`UPDATE projection_turns SET checkpoint_status='pending' WHERE thread_id=${f.owner.threadId}`;
        if (problem === "queue-handoff" || problem === "awaiting-turn") {
          const queue = {
            enabled: true,
            revision: 1,
            pauseReason: null,
            entries: [],
            admissions: [],
            finalizedTurnId: null,
            awaitingTurnId: problem === "awaiting-turn" ? "awaiting" : null,
            handoff:
              problem === "queue-handoff"
                ? {
                    attemptId: "attempt",
                    messageId: "message",
                    revision: 1,
                    controlRevision: 1,
                    mode: "next-turn",
                  }
                : null,
          };
          yield* f.sql`INSERT INTO projection_thread_prompt_queues(thread_id,state_json) VALUES(${f.owner.threadId},${encodeQueue(queue)})`;
        }
        expect(
          yield* Effect.flip(
            f.source.freeze({
              ...f.input,
              ...(problem === "wrong-owner" ? { environmentId: "foreign" } : {}),
            }),
          ),
        ).toMatchObject({ _tag: "ThreadExecutionFenceError" });
        expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
        expect(f.captures()).toBe(0);
      }),
    ),
  );
}
it.effect("a retry stays frozen if the checkpoint writer omits matching chat data", () =>
  runAttachmentCheckpointTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const source = makeThreadTransferSource(f.sql, f.events, {
        ...f.provider,
        checkpointConversation: () => Effect.void,
      });
      expect(yield* Effect.flip(source.freeze(f.input))).toMatchObject({
        _tag: "ThreadExecutionFenceError",
      });
      expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
      expect((yield* f.native.get(f.owner.threadId, 1, f.nativeInput.turnId))?.directory).toBe(
        f.point.directory,
      );
      expect((yield* f.source.freeze(f.input)).nativeCheckpointTurnId).toBe(f.nativeInput.turnId);
    }),
  ),
);
it.effect("late history cannot be exported under an older frozen watermark", () =>
  runAttachmentCheckpointTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.source.freeze(f.input);
      yield* f.message(f.attachments[2]!);
      expect((yield* Effect.result(f.source.freeze(f.input)))._tag).toBe("Failure");
      expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
    }),
  ),
);
it.effect("never freezes an active owner without its coordinator drain", () =>
  runAttachmentCheckpointTest(
    Effect.gen(function* () {
      const f = yield* attachmentCheckpointFixture;
      const source = makeThreadTransferSource(f.sql, f.events, {
        listSessions: () => Effect.succeed([]),
      });
      expect(
        yield* Effect.flip(source.freeze({ ...f.owner, operationId: NodeCrypto.randomUUID() })),
      ).toMatchObject({ _tag: "ThreadExecutionFenceError" });
      expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
    }),
  ),
);
