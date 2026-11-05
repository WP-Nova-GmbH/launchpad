import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runMigrations } from "../persistence/Migrations.ts";
import { threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import { verifyThreadAttachmentCheckpointArchive } from "./ThreadAttachmentCheckpoint.ts";
import {
  attachmentCheckpointFixture,
  runAttachmentCheckpointTest,
} from "./testUtils/threadAttachmentCheckpoint.ts";

const frozenFixture = Effect.gen(function* () {
  const f = yield* attachmentCheckpointFixture;
  yield* f.store.capture(f.input);
  yield* f.message(f.attachments[2]!);
  const operationId = NodeCrypto.randomUUID();
  yield* f.fences.beginDrain({ ...f.owner, operationId, previousOperationId: f.owner.operationId });
  const sourceSequence = yield* f.fences.freeze({ ...f.owner, operationId });
  let exports = 0;
  const exportConversation = Effect.fnUntraced(function* (stage: string) {
    exports++;
    const directory = f.path.join(stage, "conversation");
    yield* f.fs.makeDirectory(directory);
    yield* f.fs.writeFileString(f.path.join(directory, "manifest.json"), "{}");
    yield* f.fs.writeFileString(
      f.path.join(directory, "rollout.jsonl"),
      "fresh frozen native checkpoint",
    );
    return { directory, nativeThreadId: "native" };
  });
  const input = { ...f.nativeInput, operationId };
  const attachmentInput = { ...f.input, captureOperationId: operationId };
  return {
    ...f,
    operationId,
    sourceSequence,
    input,
    attachmentInput,
    exportConversation,
    exports: () => exports,
  };
});
it.effect(
  "a frozen save includes later messages and attachments without overwriting its completed turn",
  () =>
    runAttachmentCheckpointTest(
      Effect.gen(function* () {
        const f = yield* frozenFixture;
        const point = yield* f.native.captureFrozen(f.input, f.exportConversation);
        expect(point?.sourceSequence).toBe(f.sourceSequence);
        expect(point?.turnId).toBe(f.nativeInput.turnId);
        expect(point?.captureOperationId).toBe(f.operationId);
        expect(point?.directory).not.toBe(f.point.directory);
        const chat = yield* f.store.capture(f.attachmentInput);
        expect(chat.sourceSequence).toBe(f.sourceSequence);
        const { manifest } = yield* verifyThreadAttachmentCheckpointArchive(chat, f.owner.threadId);
        expect(manifest.files.map((x) => x.attachment.id)).toEqual(f.attachments.map((x) => x.id));
        expect(yield* f.native.get(f.owner.threadId, 1, f.nativeInput.turnId)).toEqual(f.point);
        expect(yield* f.native.captureFrozen(f.input, f.exportConversation)).toEqual(point);
        expect(yield* f.store.capture(f.attachmentInput)).toEqual(chat);
        expect(f.exports()).toBe(1);
        // Once captured, retries need only their immutable local archives.
        yield* f.fs.remove(f.attachmentsDir, { recursive: true });
        expect(yield* f.store.capture(f.attachmentInput)).toEqual(chat);
        expect(yield* f.native.captureFrozen(f.input, f.exportConversation)).toEqual(point);
      }),
    ),
);
it.effect(
  "missing latest chat bytes block the frozen save and leave the old complete checkpoint intact",
  () =>
    runAttachmentCheckpointTest(
      Effect.gen(function* () {
        const f = yield* frozenFixture;
        yield* f.native.captureFrozen(f.input, f.exportConversation);
        const file = f.path.join(f.attachmentsDir, `${f.attachments[2]!.id}.txt`);
        yield* f.fs.remove(file);
        yield* Effect.flip(f.store.capture(f.attachmentInput));
        expect(
          yield* f.store.get(
            f.owner.threadId,
            1,
            threadCheckpointId(f.input.turnId, f.operationId),
          ),
        ).toBeNull();
        expect(yield* f.store.get(f.owner.threadId, 1, f.input.turnId)).not.toBeNull();
        yield* f.fs.writeFileString(file, "data2");
        expect((yield* f.store.capture(f.attachmentInput)).sourceSequence).toBe(f.sourceSequence);
      }),
    ),
);
it.effect(
  "frozen capture cannot start before freezing, under another operation or with changed turn identity",
  () =>
    runAttachmentCheckpointTest(
      Effect.gen(function* () {
        const f = yield* attachmentCheckpointFixture;
        const exportConversation = () => Effect.die("Must reject before invoking the provider");
        yield* Effect.flip(
          f.native.captureFrozen(
            { ...f.nativeInput, operationId: NodeCrypto.randomUUID() },
            exportConversation,
          ),
        );
        const operationId = NodeCrypto.randomUUID();
        yield* f.fences.beginDrain({
          ...f.owner,
          operationId,
          previousOperationId: f.owner.operationId,
        });
        yield* f.fences.freeze({ ...f.owner, operationId });
        yield* Effect.flip(
          f.native.captureFrozen(
            { ...f.nativeInput, operationId: NodeCrypto.randomUUID() },
            exportConversation,
          ),
        );
      }),
    ),
);
it.effect("stopped work still awaiting relay acknowledgement prevents a final checkpoint", () =>
  runAttachmentCheckpointTest(
    Effect.gen(function* () {
      const f = yield* attachmentCheckpointFixture;
      const work = {
        threadId: f.owner.threadId,
        generation: 1,
        kind: "provider" as const,
        workId: "pending-completion",
      };
      yield* f.fences.beginWork(work);
      yield* f.fences.completeWork(work);
      const operationId = NodeCrypto.randomUUID();
      yield* f.fences.beginDrain({
        ...f.owner,
        operationId,
        previousOperationId: f.owner.operationId,
      });
      yield* f.fences.freeze({ ...f.owner, operationId });
      yield* Effect.flip(
        f.native.captureFrozen({ ...f.nativeInput, operationId }, () =>
          Effect.die("Must not export"),
        ),
      );
    }),
  ),
);
it.effect("changed frozen watermark during export cannot publish or erase the prior point", () =>
  runAttachmentCheckpointTest(
    Effect.gen(function* () {
      const f = yield* frozenFixture;
      yield* Effect.flip(
        f.native.captureFrozen(f.input, (stage) =>
          f
            .exportConversation(stage)
            .pipe(
              Effect.tap(
                () =>
                  f.sql`UPDATE thread_execution_fences SET frozen_sequence=frozen_sequence+1 WHERE thread_id=${f.owner.threadId}`,
              ),
            ),
        ),
      );
      expect(
        yield* f.native.get(f.owner.threadId, 1, threadCheckpointId(f.input.turnId, f.operationId)),
      ).toBeNull();
      expect(yield* f.native.get(f.owner.threadId, 1, f.input.turnId)).toEqual(f.point);
    }),
  ),
);
it.effect(
  "older queue and enrollment triggers cannot downgrade the frozen checkpoint reader barrier",
  () =>
    runAttachmentCheckpointTest(
      Effect.gen(function* () {
        const f = yield* frozenFixture;
        yield* f.native.captureFrozen(f.input, f.exportConversation);
        yield* f.sql`INSERT INTO orchestration_events
      (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
      VALUES ('other-move','thread','other-thread',1,'thread.prompt-queue-changed','2026-10-05T10:00:00Z','system','{"entry":{"kind":"move"}}','{}')`;
        yield* f.sql`INSERT INTO thread_execution_fences(thread_id,relay_url,environment_id,project_id,generation,operation_id,phase)
      VALUES ('other-thread','https://relay.invalid','source','other-project',1,'enroll','active')`;
        expect(yield* f.sql`SELECT name FROM effect_sql_migrations WHERE migration_id=1`).toEqual([
          { name: "OrchestrationEvents_FrozenCheckpointReaderV1" },
        ]);
        expect(yield* runMigrations()).toEqual([]);
        yield* f.sql`DELETE FROM effect_sql_migrations WHERE migration_id=69`;
        yield* Effect.flip(runMigrations());
      }),
    ),
);

it.effect("a final checkpoint requires an enrolled fence and rejects a changed turn on retry", () =>
  runAttachmentCheckpointTest(
    Effect.gen(function* () {
      const f = yield* frozenFixture;
      yield* Effect.flip(
        f.native.captureFrozen({ ...f.input, threadId: "not-enrolled" }, () =>
          Effect.die("Must reject before export"),
        ),
      );
      yield* f.native.captureFrozen(f.input, f.exportConversation);
      yield* Effect.flip(
        f.native.captureFrozen({ ...f.input, turnId: "another-turn" }, () =>
          Effect.die("Must reject before export"),
        ),
      );
      expect(f.exports()).toBe(1);
    }),
  ),
);
it.effect("a changed freeze watermark cannot silently reuse its earlier final checkpoint", () =>
  runAttachmentCheckpointTest(
    Effect.gen(function* () {
      const f = yield* frozenFixture;
      yield* f.native.captureFrozen(f.input, f.exportConversation);
      const before = yield* f.native.get(
        f.owner.threadId,
        1,
        threadCheckpointId(f.input.turnId, f.operationId),
      );
      const event = yield* f.message(f.attachments[2]!);
      yield* f.sql`UPDATE thread_execution_fences SET frozen_sequence=${event.sequence} WHERE thread_id=${f.owner.threadId}`;
      yield* Effect.flip(
        f.native.captureFrozen(f.input, () => Effect.die("Must reject before export")),
      );
      expect(
        yield* f.native.get(f.owner.threadId, 1, threadCheckpointId(f.input.turnId, f.operationId)),
      ).toEqual(before);
      yield* Effect.flip(f.store.capture(f.attachmentInput));
    }),
  ),
);
