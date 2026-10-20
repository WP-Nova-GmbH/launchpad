import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as Credentials from "../relay/OrganizationSourceControlCredentials.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { CheckoutAccess, layer, make } from "./CheckoutAccess.ts";

let serial = 0;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    sql = yield* SqlClient.SqlClient;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "checkout-access-" }),
  );
  const main = path.join(root, "main"),
    held = path.join(root, "held"),
    sibling = path.join(root, "sibling");
  for (const dir of [main, held, sibling]) yield* fs.makeDirectory(dir);
  const id = `guard-${++serial}`;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${id}, 'Project', ${main}, '[]', '2026-10-05T10:00:00.000Z', '2026-10-05T10:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, worktree_path, created_at, updated_at)
    VALUES (${`${id}-other`}, ${id}, 'Other', '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default', ${sibling}, '2026-10-05T10:00:00.000Z', '2026-10-05T10:00:00.000Z')`;
  yield* sql`INSERT INTO thread_execution_fences (thread_id, relay_url, environment_id, project_id, generation, operation_id, phase)
    VALUES (${id}, 'https://relay.example', 'destination', ${id}, 2, ${id}, 'frozen')`;
  yield* sql`INSERT INTO thread_checkout_claims (operation_id, thread_id, generation, project_id, repository_root, checkout_path, mode, branch,
    manifest_sha256, workspace_sha256, inspection_json, phase) VALUES (${id}, ${id}, 2, ${id}, ${main}, ${held}, 'worktree', 'move', ${"a".repeat(64)}, ${"b".repeat(64)}, '{}', 'reserved')`;
  const access = yield* CheckoutAccess;
  return { root, main, held, sibling, id, fs, path, sql, access };
});
it.layer(
  layer.pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer)),
)("checkout reservation boundaries", (it) => {
  it.effect("blocks aliases and new files but permits unrelated workspace edits", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const alias = f.path.join(f.root, "alias");
      yield* f.fs.symlink(f.held, alias);
      for (const file of [f.held, f.path.join(f.held, "not-yet-created", "file"), alias])
        expect((yield* Effect.flip(f.access.assertAvailable({ path: file }))).message).toContain(
          "reserved",
        );
      yield* f.access.assertAvailable({ path: f.main });
      yield* f.access.assertAvailable({ path: f.sibling });
      for (const file of [f.main, f.sibling])
        yield* Effect.flip(f.access.assertAvailable({ path: file, repository: true }));
      yield* f.sql`UPDATE thread_checkout_claims SET phase = 'released', release_reason = 'cancelled' WHERE operation_id = ${f.id}`;
      yield* f.access.assertAvailable({ path: alias, repository: true });
    }),
  );
  it.effect("stops background Git before spawning and resumes after release", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let executions = 0;
      const vcs = yield* VcsProcess.guarded.pipe(
        Effect.provide(Credentials.layerNone),
        Effect.provideService(ProcessRunner, {
          run: () =>
            Effect.sync(() => {
              executions++;
              return {
                code: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      );
      const request = {
        command: "git",
        args: ["fetch", "origin"],
        cwd: f.sibling,
        operation: "background-fetch",
      };
      expect((yield* Effect.flip(vcs.run(request))).message).toContain("reserved");
      expect(executions).toBe(0);
      yield* f.sql`UPDATE thread_checkout_claims SET phase = 'released', release_reason = 'cancelled' WHERE operation_id = ${f.id}`;
      yield* vcs.run(request);
      expect(executions).toBe(1);
    }),
  );
  it.effect("checks the actual spawn directory as well as the logical Git directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let spawned = false;
      const vcs = yield* VcsProcess.guarded.pipe(
        Effect.provide(Credentials.layerNone),
        Effect.provideService(ProcessRunner, {
          run: () =>
            Effect.sync(() => {
              spawned = true;
              throw new Error("must not spawn");
            }),
        }),
      );
      const unrelated = f.path.join(f.root, "unrelated");
      yield* f.fs.makeDirectory(unrelated);
      yield* Effect.flip(
        vcs.run({
          command: "git",
          args: ["status"],
          cwd: unrelated,
          spawnCwd: f.held,
          operation: "test",
        }),
      );
      expect(spawned).toBe(false);
      expect(
        yield* f.sql`SELECT 1 FROM checkout_operations WHERE operation_id IN
        (SELECT operation_id FROM checkout_operation_paths WHERE path = ${unrelated})`,
      ).toEqual([]);
    }),
  );
  it.effect("retains interrupted Git work after service reconstruction", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE thread_checkout_claims SET phase = 'released' WHERE operation_id = ${f.id}`;
      const started = yield* Deferred.make<void>();
      const vcs = yield* VcsProcess.guarded.pipe(
        Effect.provide(Credentials.layerNone),
        Effect.provideService(ProcessRunner, {
          run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      const running = yield* vcs
        .run({ command: "git", args: ["fetch"], cwd: f.main, operation: "test" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      yield* make;
      const pending = yield* f.sql<{
        operationId: string;
      }>`SELECT operation_id AS "operationId" FROM checkout_operation_projects WHERE project_id = ${f.id}`;
      expect(pending).toHaveLength(1);
      // Test-only stop acknowledgement, never inferred from the interrupted fiber.
      yield* f.access.complete(pending[0]!.operationId);
    }),
  );
  it.effect("serializes freeze against an already admitted checkout write", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE thread_checkout_claims SET phase = 'released' WHERE operation_id = ${f.id}`;
      const threadId = `${f.id}-other`;
      const fence = makeThreadExecutionFence(f.sql);
      const identity = {
        threadId,
        projectId: f.id,
        environmentId: "source",
        relayUrl: "https://relay.example",
        generation: 1,
        operationId: "enroll",
      };
      yield* fence.prepare(identity);
      yield* fence.activate(identity);
      const move = { threadId, generation: 1, operationId: "move", previousOperationId: "enroll" };
      yield* fence.beginDrain(move);
      const operationId = yield* f.access.begin({ paths: [f.sibling], kind: "write-file" });
      expect((yield* Effect.flip(fence.freeze(move))).message).toContain("operations");
      const recovered = makeThreadExecutionFence(f.sql);
      yield* Effect.flip(recovered.freeze(move));
      yield* f.access.complete(operationId);
      yield* recovered.freeze(move);
      yield* Effect.flip(f.access.begin({ paths: [f.sibling], kind: "write-file" }));
      expect(
        yield* f.sql`SELECT 1 FROM checkout_operation_projects WHERE project_id = ${f.id}`,
      ).toEqual([]);
    }),
  );
  it.effect("preserves file bytes and does not create directories while the checkout is held", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(f.path.join(f.held, "original"), "keep");
      const workspace = yield* WorkspaceFileSystem.guarded.pipe(
        Effect.provide(
          Layer.merge(
            WorkspacePaths.layer,
            Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
          ),
        ),
      );
      yield* Effect.flip(
        workspace.writeFile({ cwd: f.held, relativePath: "original", contents: "overwrite" }),
      );
      yield* Effect.flip(
        workspace.writeFile({ cwd: f.held, relativePath: "new/file", contents: "new" }),
      );
      expect(yield* f.fs.readFileString(f.path.join(f.held, "original"))).toBe("keep");
      expect(yield* f.fs.exists(f.path.join(f.held, "new"))).toBe(false);
      yield* f.sql`UPDATE thread_checkout_claims SET phase = 'released', release_reason = 'cancelled' WHERE operation_id = ${f.id}`;
      yield* workspace.writeFile({ cwd: f.held, relativePath: "original", contents: "allowed" });
      expect(yield* f.fs.readFileString(f.path.join(f.held, "original"))).toBe("allowed");
    }),
  );
});
