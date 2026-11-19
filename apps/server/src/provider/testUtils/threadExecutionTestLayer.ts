// @effect-diagnostics nodeBuiltinImport:off - Isolated fixture checkout identities.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveCheckoutPath } from "../../workspace/CheckoutAccess.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadExecution } from "../../relay/ThreadExecution.ts";
import {
  makeThreadExecutionRelay,
  ThreadExecutionRelayError,
} from "../../relay/ThreadExecutionRelay.ts";

/** Ordinary fixtures register a checkout; accidental portable execution still fails closed. */
export const threadExecutionTestLayerForDatabase = Layer.effect(
  ThreadExecution,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const execution = makeThreadExecutionRelay(
      sql,
      {
        admit: (work) =>
          Effect.fail(
            new ThreadExecutionRelayError({
              threadId: work.threadId,
              operation: "admit",
              detail: "No test relay configured",
            }),
          ),
        complete: (work) =>
          Effect.fail(
            new ThreadExecutionRelayError({
              threadId: work.threadId,
              operation: "complete",
              detail: "No test relay configured",
            }),
          ),
      },
      undefined,
      { canonicalizeRoot: (root) => resolveCheckoutPath(root, fs, path) },
    );
    const ensureFixtureBinding = Effect.fnUntraced(function* (threadId: string) {
      const existing = yield* sql`SELECT 1 FROM projection_threads WHERE thread_id=${threadId}`;
      if (existing.length > 0) return;
      const projectId = `provider-fixture:${threadId}`;
      const root = NodePath.resolve(process.cwd(), "provider-test-fixtures", threadId);
      yield* sql`INSERT OR IGNORE INTO projection_projects
        (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${projectId},'Provider fixture',${root},'[]','2026-10-27','2026-10-27')`;
      yield* sql`INSERT OR IGNORE INTO projection_threads
        (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
        VALUES (${threadId},${projectId},'Provider fixture','{"instanceId":"codex","model":"gpt-5"}','full-access','default','2026-10-27','2026-10-27')`;
    });
    return {
      ...execution,
      begin: (work: Parameters<typeof execution.begin>[0]) =>
        ensureFixtureBinding(work.threadId).pipe(Effect.andThen(execution.begin(work))),
      assertAccepting: (threadId: string) =>
        ensureFixtureBinding(threadId).pipe(Effect.andThen(execution.assertAccepting(threadId))),
    };
  }),
).pipe(Layer.provide(NodeServices.layer));
export const threadExecutionTestLayer = threadExecutionTestLayerForDatabase.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
