import * as Stream from "effect/Stream";
import { makeThreadMoveCheckpointStore } from "./ThreadMoveCheckpointStore.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Schema from "effect/Schema";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { prepareMoveCheckpointArchive } from "./testUtils/moveCheckpointCatalog.ts";
import { repositoryUploadCatalogFixture } from "./testUtils/repositoryUploadCatalog.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadJournalStore } from "./ThreadJournalStore.ts";
const decode = Schema.decodeUnknownSync(OrchestrationEvent);
const fixture = Effect.fnUntraced(function* (
  input: {
    omit?: string;
    corruptHistoryId?: boolean;
    corruptHistoryText?: boolean;
    priorProvider?: boolean;
    vmDestination?: boolean;
    bundleContent?: Uint8Array;
  } = {},
) {
  const sql = yield* PgClient.PgClient,
    fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "move-save-proof-" }),
    threadId = NodeCrypto.randomUUID(),
    sourceEnvironmentId = `source-${threadId}`;
  const placements = makeThreadPlacementStore(sql),
    journal = makeThreadJournalStore(sql),
    owner = { threadId, environmentId: sourceEnvironmentId, generation: 1 };
  yield* placements.enroll({
    threadId,
    environmentId: sourceEnvironmentId,
    projectId: "project",
    organizationId: "org",
    repositoryId: "repo",
    ownerUserId: "user",
  });
  const at = "2026-10-07T10:00:00.000Z";
  const event = (type: string, payload: unknown, sequence: number) =>
    decode({
      type,
      sequence,
      eventId: `${threadId}-${sequence}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload,
    });
  const history = [
    event(
      "thread.created",
      {
        threadId,
        projectId: "project",
        title: "Empty native thread",
        modelSelection: { provider: "codex", model: "gpt-5", instanceId: "codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      },
      1,
    ),
    event(
      "thread.message-sent",
      {
        threadId,
        messageId: "message",
        role: input.priorProvider ? "assistant" : "user",
        text: "remember this",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
      3,
    ),
  ];
  for (const e of history) yield* journal.append({ ...owner, event: e });
  // A global scanner watermark can be ahead of this thread's own last event.
  yield* journal.confirmThrough({ ...owner, sourceSequence: 50 });
  return yield* prepareMoveCheckpointArchive({
    sql,
    fs,
    root,
    threadId,
    sourceEnvironmentId,
    history,
    ...input,
  });
});
describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "frozen move recovery saves (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect("replaces the retained upload only after a new local move completes", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const sql = yield* PgClient.PgClient;
            const recovery = makeThreadMoveCheckpointStore(sql, f.objects);
            const first = yield* repositoryUploadCatalogFixture(sql, f.objects, f.move.threadId);
            const second = yield* repositoryUploadCatalogFixture(
              sql,
              f.objects,
              f.move.threadId,
              "c".repeat(40),
              2,
            );
            yield* sql`UPDATE relay_thread_moves SET phase='preparing' WHERE operation_id=${second.operationId}`;
            yield* recovery.retire(f.move.threadId);
            expect((yield* recovery.repositoryUpload(f.move.threadId))?.operationId).toBe(
              first.operationId,
            );
            yield* sql`UPDATE relay_thread_moves SET phase='aborted' WHERE operation_id=${second.operationId}`;
            yield* recovery.retire(f.move.threadId);
            expect(
              yield* recovery.repositoryUpload(f.move.threadId, second.operationId),
            ).toBeNull();
            expect((yield* recovery.repositoryUpload(f.move.threadId))?.operationId).toBe(
              first.operationId,
            );
            const third = yield* repositoryUploadCatalogFixture(
              sql,
              f.objects,
              f.move.threadId,
              "d".repeat(40),
              3,
            );
            yield* recovery.retire(f.move.threadId);
            expect((yield* recovery.repositoryUpload(f.move.threadId))?.operationId).toBe(
              third.operationId,
            );
            expect(yield* recovery.repositoryUpload(f.move.threadId, first.operationId)).toBeNull();
            expect(
              yield* sql`SELECT 1 FROM relay_thread_artifact_pins WHERE operation_id IN
            (${`move-repository:${first.operationId}`},${`move-repository:${second.operationId}`})`,
            ).toHaveLength(0);
            expect(
              yield* sql`SELECT 1 FROM relay_thread_artifact_pins WHERE operation_id=${`move-repository:${third.operationId}`}`,
            ).toHaveLength(1);
          }),
        ),
      );
      it.effect(
        "retains the local Git upload after disposable move data and conversation pins retire",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const bytes = new TextEncoder().encode("retained repository bytes");
              const f = yield* fixture({ vmDestination: true, bundleContent: bytes });
              const sql = yield* PgClient.PgClient;
              const recovery = makeThreadMoveCheckpointStore(sql, f.objects);
              yield* f.publish;
              expect(yield* recovery.repositoryUpload(f.move.threadId)).toBeNull();
              yield* f.ready;
              yield* f.placements.commitMove(f.move);
              yield* f.placements.activated({
                ...f.move,
                environmentId: f.move.destinationEnvironmentId,
                generation: 2,
              });
              yield* f.store.releasePins(f.move.operationId);
              yield* sql`UPDATE relay_thread_move_checkpoints SET retained=false WHERE operation_id=${f.move.operationId}`;
              yield* sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${`move-recovery:${f.move.operationId}`}`;
              yield* sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()-interval '40 days' WHERE thread_id=${f.move.threadId}`;
              while (yield* f.transfer.collectOne()) {
                /* Drain eligible disposable artifacts. */
              }
              const repository = (yield* recovery.repositoryUpload(f.move.threadId))!;
              expect(repository.revision).toBe(f.header.workspace.head);
              expect(repository.branch).toBe(f.header.workspace.branch);
              const body = yield* recovery.openRepositoryUpload({
                threadId: f.move.threadId,
                operationId: repository.operationId,
                artifactId: repository.bundle.chunks[0]!.artifactId,
              });
              const read = yield* Stream.runCollect(body);
              expect(new TextDecoder().decode(read[0])).toBe("retained repository bytes");
              yield* Effect.flip(
                recovery.openRepositoryUpload({
                  threadId: "other-thread",
                  operationId: repository.operationId,
                  artifactId: repository.bundle.chunks[0]!.artifactId,
                }),
              );
            }),
          ),
      );
      it.effect(
        "never-started threads require a complete frozen save and retain it after cutover",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                sql = yield* PgClient.PgClient;
              const recovery = makeThreadMoveCheckpointStore(sql, f.objects);
              const identity = { ...f.move, manifestArtifactId: f.manifestArtifactId };
              expect(yield* recovery.isRetainedComplete(identity)).toBe(false);
              yield* f.ready;
              expect(yield* Effect.flip(f.placements.commitMove(f.move))).toMatchObject({
                _tag: "ThreadPlacementConflict",
              });
              yield* f.publish;
              yield* f.publish;
              expect(yield* recovery.isRetainedComplete(identity)).toBe(true);
              expect(
                yield* recovery.isRetainedComplete({
                  ...identity,
                  manifestArtifactId: NodeCrypto.randomUUID(),
                }),
              ).toBe(false);
              const [row] = yield* sql<{
                native: string | null;
                count: number;
                branch: string | null;
                revision: string | null;
              }>`SELECT native_checkpoint_operation_id AS native,artifact_count AS count,workspace_branch AS branch,workspace_revision AS revision FROM relay_thread_move_checkpoints WHERE operation_id=${f.move.operationId}`;
              expect(row?.native).toBeNull();
              expect(row?.count).toBe(5);
              expect(row?.branch).toBe("main");
              expect(row?.revision).toBe("a".repeat(40));
              yield* f.placements.commitMove(f.move);
              yield* f.placements.commitMove(f.move);
              expect((yield* f.placements.get(f.move.threadId))?.generation).toBe(2);
              yield* f.placements.activated({
                ...f.move,
                environmentId: f.move.destinationEnvironmentId,
                generation: 2,
              });
              yield* f.store.releasePins(f.move.operationId);
              yield* sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()-interval '40 days' WHERE thread_id=${f.move.threadId}`;
              let collected = 0;
              while (yield* f.transfer.collectOne()) collected++;
              expect(collected).toBe(1); // Git payloads only; complete chat/history and their manifests survive.
              const [pins] = yield* sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_artifact_pins WHERE operation_id=${`move-recovery:${f.move.operationId}`}`;
              expect(pins?.count).toBe(5);
              expect((yield* recovery.latest(f.move.threadId))?.operationId).toBe(
                f.move.operationId,
              );
              yield* recovery
                .readRetained({
                  threadId: f.move.threadId,
                  operationId: f.move.operationId,
                  artifactId: f.manifestArtifactId,
                })
                .pipe(Stream.runDrain);
              yield* Effect.flip(
                recovery
                  .readRetained({
                    threadId: NodeCrypto.randomUUID(),
                    operationId: f.move.operationId,
                    artifactId: f.manifestArtifactId,
                  })
                  .pipe(Stream.runDrain),
              );
              yield* Effect.flip(
                recovery
                  .readRetained({
                    threadId: f.move.threadId,
                    operationId: f.move.operationId,
                    artifactId: f.uploads.find((e) => e.kind === "workspace")!.artifactId,
                  })
                  .pipe(Stream.runDrain),
              );
            }),
          ),
      );
      for (const omit of [
        "history/events.jsonl",
        "history/receipts.jsonl",
        "attachments/manifest.json",
      ])
        it.effect(`missing ${omit} blocks handoff`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture({ omit });
              yield* Effect.flip(f.publish);
              yield* f.ready;
              yield* Effect.flip(f.placements.commitMove(f.move));
              expect((yield* f.placements.get(f.move.threadId))?.environmentId).toBe(
                f.owner.environmentId,
              );
            }),
          ),
        );
      it.effect("valid hashes cannot replace the independently mirrored event identities", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture({ corruptHistoryId: true });
            expect(yield* Effect.flip(f.publish)).toMatchObject({
              _tag: "ThreadMoveCheckpointConflict",
            });
            yield* f.ready;
            yield* Effect.flip(f.placements.commitMove(f.move));
          }),
        ),
      );
      it.effect("matching event identities cannot conceal altered conversation content", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture({ corruptHistoryText: true });
            expect(yield* Effect.flip(f.publish)).toMatchObject({
              _tag: "ThreadMoveCheckpointConflict",
            });
          }),
        ),
      );
      it.effect("a prior assistant turn cannot be converted into a fresh conversation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture({ priorProvider: true });
            expect(yield* Effect.flip(f.publish)).toMatchObject({
              _tag: "ThreadMoveCheckpointConflict",
            });
          }),
        ),
      );
      it.effect("a damaged recovery pin set blocks ownership commit", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              sql = yield* PgClient.PgClient;
            yield* f.publish;
            yield* f.ready;
            yield* sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${`move-recovery:${f.move.operationId}`} AND artifact_id=${f.manifestArtifactId}`;
            expect(
              yield* makeThreadMoveCheckpointStore(sql, f.objects).isRetainedComplete({
                ...f.move,
                manifestArtifactId: f.manifestArtifactId,
              }),
            ).toBe(false);
            yield* Effect.flip(f.placements.commitMove(f.move));
            expect((yield* f.placements.get(f.move.threadId))?.environmentId).toBe(
              f.owner.environmentId,
            );
          }),
        ),
      );
      it.effect(
        "completed recovery saves retain only the newest two while an active save stays pinned",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const first = yield* fixture(),
                sql = yield* PgClient.PgClient,
                fs = yield* FileSystem.FileSystem;
              const finish = Effect.fnUntraced(function* (f: typeof first) {
                yield* f.publish;
                yield* f.placements.requestAbort(f.move);
                yield* f.placements.destinationRemoved(f.move);
                yield* f.store.releasePins(f.move.operationId);
              });
              yield* finish(first);
              const history = yield* sql<{
                event: OrchestrationEvent;
              }>`SELECT event_json AS event FROM relay_thread_history WHERE thread_id=${first.move.threadId} ORDER BY cursor`;
              const root = yield* fs.makeTempDirectoryScoped({ prefix: "move-save-retention-" });
              const second = yield* prepareMoveCheckpointArchive({
                sql,
                fs,
                root,
                threadId: first.move.threadId,
                sourceEnvironmentId: first.owner.environmentId,
                history: history.map((e) => e.event),
              });
              yield* finish(second);
              const third = yield* prepareMoveCheckpointArchive({
                sql,
                fs,
                root,
                threadId: first.move.threadId,
                sourceEnvironmentId: first.owner.environmentId,
                history: history.map((e) => e.event),
              });
              yield* third.publish;
              const [during] = yield* sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_move_checkpoints WHERE thread_id=${first.move.threadId} AND retained`;
              expect(during?.count).toBe(3);
              yield* finish(third);
              const [after] = yield* sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_move_checkpoints WHERE thread_id=${first.move.threadId} AND retained`;
              expect(after?.count).toBe(2);
              yield* Effect.flip(
                makeThreadMoveCheckpointStore(sql, first.objects)
                  .readRetained({
                    threadId: first.move.threadId,
                    operationId: first.move.operationId,
                    artifactId: first.manifestArtifactId,
                  })
                  .pipe(Stream.runDrain),
              );
            }),
          ),
      );
      it.effect("unreconciled source admissions block ownership commit", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              sql = yield* PgClient.PgClient;
            yield* f.publish;
            yield* f.ready;
            yield* sql`INSERT INTO relay_thread_execution_admissions (thread_id,work_id,environment_id,generation) VALUES (${f.move.threadId},'uncertain-work',${f.owner.environmentId},1)`;
            yield* Effect.flip(f.placements.commitMove(f.move));
          }),
        ),
      );
    });
  },
);
