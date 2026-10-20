import {
  ThreadVmRestoreBoot,
  ThreadNativeCheckpointPublicationReceipt,
} from "@t3tools/contracts/relay";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadHistoryArchive, ThreadHistoryArchiveManifest } from "./ThreadHistoryArchive.ts";
import { flushThreadArtifactTree } from "./ThreadArtifactDurability.ts";

const decodeBoot = Schema.decodeUnknownEffect(ThreadVmRestoreBoot);
const decodePoint = Schema.decodeUnknownEffect(ThreadNativeCheckpointPublicationReceipt);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ThreadHistoryArchiveManifest));
export class ThreadVmRestoreHistoryError extends Schema.TaggedError<ThreadVmRestoreHistoryError>()(
  "ThreadVmRestoreHistoryError",
  { message: Schema.String, stage: Schema.optionalKey(Schema.String) },
) {}
const isRestoreHistoryError = Schema.is(ThreadVmRestoreHistoryError);
const fail = (stage = "read") =>
  new ThreadVmRestoreHistoryError({
    stage,
    message:
      "Saved thread history does not match the pinned recovery point. Execution remains blocked.",
  });

/** Only workspace selection comes from an older backup in independent-history
 * recovery. Its event store, provider home and execution state are discarded. */
export const readThreadVmRestoreWorkspace = Effect.fn("ThreadVmRestoreHistory.workspace")(
  function* (input: { boot: ThreadVmRestoreBoot; baseDir: string; workspaceRoot: string }) {
    const boot = yield* decodeBoot(input.boot),
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const base = path.resolve(input.baseDir),
      source = path.join(`${base}-restores`, boot.allocationId, "source"),
      database = path.join(source, "userdata", "state.sqlite");
    if (
      (yield* fs.realPath(source)) !== source ||
      (yield* fs.realPath(database)) !== database ||
      (yield* fs.stat(database)).type !== "File"
    )
      return yield* fail("storage");
    for (const sibling of [database + "-wal", database + "-shm"])
      if (
        (yield* fs.exists(sibling)) &&
        ((yield* fs.realPath(sibling)) !== sibling || (yield* fs.stat(sibling)).type !== "File")
      )
        return yield* fail("storage");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [workspace] = yield* sql<{
        repositoryRoot: string;
        worktreePath: string | null;
        branch: string | null;
      }>`SELECT p.workspace_root AS "repositoryRoot",t.worktree_path AS "worktreePath",t.branch FROM projection_threads t JOIN projection_projects p USING(project_id) WHERE t.thread_id=${boot.threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
      const repositoryRoot = path.resolve(input.workspaceRoot),
        checkoutPath = workspace?.worktreePath ?? repositoryRoot,
        worktrees = path.join(base, "worktrees");
      if (
        !workspace ||
        workspace.repositoryRoot !== repositoryRoot ||
        path.resolve(checkoutPath) !== checkoutPath ||
        (checkoutPath !== repositoryRoot && !checkoutPath.startsWith(worktrees + path.sep))
      )
        return yield* fail("workspace");
      return { repositoryRoot, checkoutPath, branch: workspace.branch };
    }).pipe(
      Effect.provide(NodeSqlite.layer({ filename: database, readonly: true })),
      Effect.scoped,
    );
  },
  Effect.mapError((error) => (isRestoreHistoryError(error) ? error : fail())),
);

/** Export only one frozen thread and its deduplication receipts from the quarantined
 * disk. No migrations, identity layers, reactors or source database writes run here.
 * Rebind the verified archive header to the new restore; original event IDs/authors
 * and source watermarks remain unchanged for destination-local baseline import. */
export const exportThreadVmRestoreHistory = Effect.fn("ThreadVmRestoreHistory.export")(
  function* (input: {
    boot: ThreadVmRestoreBoot;
    native: ThreadNativeCheckpointPublicationReceipt;
    artifactRoot: string;
    baseDir?: string;
    workspaceRoot?: string;
  }) {
    const boot = yield* decodeBoot(input.boot),
      point = yield* decodePoint(input.native);
    if (
      boot.threadId !== point.threadId ||
      boot.generation !== point.generation + 1 ||
      !point.captureOperationId
    )
      return yield* fail("scope");
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const base = path.resolve(input.baseDir ?? "/home/user/.launchpad");
    const source = path.join(`${base}-restores`, boot.allocationId, "source");
    const database = path.join(source, "userdata", "state.sqlite");
    if (
      (yield* fs.realPath(source)) !== source ||
      (yield* fs.realPath(database)) !== database ||
      (yield* fs.stat(database)).type !== "File"
    )
      return yield* fail("storage");
    for (const sibling of [database + "-wal", database + "-shm"])
      if (
        (yield* fs.exists(sibling)) &&
        ((yield* fs.realPath(sibling)) !== sibling || (yield* fs.stat(sibling)).type !== "File")
      )
        return yield* fail();
    const scratch = path.resolve(input.artifactRoot);
    let ancestor = scratch;
    while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
    const canonical = path.resolve(yield* fs.realPath(ancestor), path.relative(ancestor, scratch));
    if (canonical === source || canonical.startsWith(source + path.sep)) return yield* fail();
    const owner = {
      threadId: point.threadId,
      environmentId: point.sourceEnvironmentId,
      generation: point.generation,
      operationId: point.captureOperationId,
    };
    const read = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient,
        events = yield* OrchestrationEventStore;
      const fence = yield* makeThreadExecutionFence(sql).get(point.threadId);
      const owners = yield* sql`SELECT thread_id FROM thread_execution_fences LIMIT 2`;
      const unfinished =
        yield* sql`SELECT 1 FROM thread_execution_work WHERE completed=0 OR relay_completed=0 LIMIT 1`;
      if (
        owners.length !== 1 ||
        unfinished.length ||
        !fence ||
        fence.frozenSequence !== point.sourceSequence ||
        fence.phase !== "frozen"
      )
        return yield* fail("fence");
      const [workspace] = yield* sql<{
        repositoryRoot: string;
        worktreePath: string | null;
        branch: string | null;
      }>`
        SELECT p.workspace_root AS "repositoryRoot",t.worktree_path AS "worktreePath",t.branch
        FROM projection_threads t JOIN projection_projects p USING(project_id)
        WHERE t.thread_id=${point.threadId} AND t.project_id=${fence.projectId}
          AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
      const repositoryRoot = path.resolve(input.workspaceRoot ?? "/workspace/project");
      const checkoutPath = workspace?.worktreePath ?? repositoryRoot;
      const worktreesRoot = path.join(base, "worktrees");
      if (
        !workspace ||
        workspace.repositoryRoot !== repositoryRoot ||
        (checkoutPath !== repositoryRoot && !checkoutPath.startsWith(worktreesRoot + path.sep))
      )
        return yield* fail("workspace");
      const archive = yield* makeThreadHistoryArchive(sql, events).exportFrozen({
        ...owner,
        artifactRoot: scratch,
      });
      return { ...archive, workspace: { repositoryRoot, checkoutPath, branch: workspace.branch } };
    }).pipe(
      Effect.provide(
        // The serving engine has its own event-store layer. A fresh build binds
        // this reader to the saved DB instead of reusing the serving instance.
        Layer.fresh(
          OrchestrationEventStoreLive.pipe(
            Layer.provideMerge(NodeSqlite.layer({ filename: database, readonly: true })),
          ),
        ),
      ),
      Effect.scoped,
    );
    const archive = yield* read;
    if (archive.manifest.sourceSequence !== point.sourceSequence) return yield* fail();
    const manifest = { ...archive.manifest, operationId: boot.operationId };
    yield* fs.writeFileString(
      path.join(archive.directory, "manifest.json"),
      yield* encodeManifest(manifest),
      { mode: 0o600 },
    );
    yield* flushThreadArtifactTree(archive.directory);
    return { directory: archive.directory, manifest, workspace: archive.workspace };
  },
  Effect.mapError((error) => (isRestoreHistoryError(error) ? error : fail())),
);
