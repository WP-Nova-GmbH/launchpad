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
import { CheckoutAdmission, makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";
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
const pausedAdmission = Effect.fnUntraced(function* () {
  const f = yield* fixture;
  yield* f.sql`UPDATE thread_checkout_claims SET phase = 'released' WHERE operation_id = ${f.id}`;
  const preparing = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  let paused = false;
  const access = yield* make.pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...f.fs,
      realPath: (requested) =>
        Effect.gen(function* () {
          if (requested === f.main && !paused) {
            paused = true;
            yield* Deferred.succeed(preparing, undefined);
            yield* Deferred.await(resume);
          }
          return yield* f.fs.realPath(requested);
        }),
    }),
  );
  return { ...f, access, preparing, resume };
});
it.layer(
  layer.pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer)),
)("checkout reservation boundaries", (it) => {
  it.effect("records linked worktree Git metadata and blocks it during sibling capture", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE thread_checkout_claims SET phase='released' WHERE operation_id=${f.id}`;
      const common = f.path.join(f.main, ".git");
      const linked = f.path.join(common, "worktrees", "sibling");
      yield* f.fs.makeDirectory(linked, { recursive: true });
      yield* f.fs.writeFileString(f.path.join(linked, "commondir"), "../..\n");
      yield* f.fs.writeFileString(f.path.join(f.sibling, ".git"), `gitdir: ${linked}\n`);
      const git = yield* f.access.begin({ paths: [f.sibling], kind: "vcs" });
      expect(
        yield* f.sql`SELECT path FROM checkout_operation_paths WHERE operation_id=${git} ORDER BY path`,
      ).toEqual([common, f.sibling].sort().map((path) => ({ path })));
      const capture = makeCheckoutCapture(f.sql);
      const owner = {
        threadId: f.id,
        operationId: f.id,
        generation: 2,
        environmentId: "destination",
      };
      yield* capture.acquireDrain({ ...owner, checkoutRoot: f.main, gitCommonRoot: common });
      yield* Effect.flip(capture.enterCapturing(owner));
      yield* f.access.complete(git);
      yield* capture.enterCapturing(owner);
      const write = yield* f.access.begin({ paths: [f.sibling], kind: "write-file" });
      yield* f.access.complete(write);
      expect(
        (yield* Effect.flip(f.access.begin({ paths: [f.sibling], kind: "vcs" }))).retryable,
      ).toBe(true);
      yield* capture.release(owner, { outcome: "sealed", manifestSha256: "c".repeat(64) });
      const resumed = yield* f.access.begin({ paths: [f.sibling], kind: "vcs" });
      yield* f.access.complete(resumed);
    }),
  );

  it.effect("releases sibling access while keeping the moving thread and destination fenced", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.makeDirectory(f.path.join(f.main, ".git"));
      yield* f.sql`UPDATE thread_checkout_claims SET phase='released' WHERE operation_id=${f.id}`;
      yield* f.sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
        VALUES(${f.id},${f.id},'Moving','{"instanceId":"codex","model":"gpt-5"}','full-access','default','2026-10-27','2026-10-27')`;
      yield* f.sql`UPDATE projection_threads SET worktree_path=NULL WHERE thread_id=${`${f.id}-other`}`;
      const capture = makeCheckoutCapture(f.sql);
      const owner = {
        operationId: f.id,
        threadId: f.id,
        generation: 2,
        environmentId: "destination",
      };
      yield* capture.acquireDrain({
        ...owner,
        checkoutRoot: f.main,
        gitCommonRoot: f.path.join(f.main, ".git"),
      });
      yield* capture.enterCapturing(owner);
      yield* capture.release(owner, { outcome: "sealed", manifestSha256: "a".repeat(64) });
      const fence = makeThreadExecutionFence(f.sql);
      yield* f.access.assertAvailable({ path: f.main });
      const operation = yield* f.access.begin({ paths: [f.main], kind: "vcs" });
      yield* f.access.complete(operation);
      yield* f.access.projectRegistrationPath(f.main);
      yield* fence.assertProjectMutable(f.id);
      yield* fence.assertMutable(`${f.id}-other`);
      yield* Effect.flip(fence.assertMutable(f.id));
      yield* f.sql`UPDATE thread_execution_fences SET phase='retired' WHERE thread_id=${f.id}`;
      yield* fence.assertProjectMutable(f.id);
      yield* Effect.flip(fence.assertMutable(f.id));
      yield* f.sql`UPDATE thread_checkout_claims SET phase='reserved' WHERE operation_id=${f.id}`;
      yield* f.sql`INSERT INTO thread_checkout_claim_projects(operation_id,project_id) VALUES(${f.id},${f.id})`;
      yield* Effect.flip(f.access.assertAvailable({ path: f.held }));
      yield* Effect.flip(fence.assertProjectMutable(f.id));
    }),
  );

  it.effect("requires matching released capture operation, thread and generation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE thread_checkout_claims SET phase='released' WHERE operation_id=${f.id}`;
      yield* f.sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
        VALUES(${f.id},${f.id},'Moving','{"instanceId":"codex","model":"gpt-5"}','full-access','default','2026-10-27','2026-10-27')`;
      yield* f.sql`INSERT INTO checkout_capture_holds(operation_id,thread_id,generation,environment_id,checkout_root,git_common_root,admission_sequence,phase,release_outcome,manifest_sha256)
        VALUES(${f.id},${f.id},2,'destination',${f.main},${f.main},0,'released','sealed',${"b".repeat(64)})`;
      const fence = makeThreadExecutionFence(f.sql);
      for (const mismatch of ["operation", "thread", "generation"] as const) {
        yield* f.sql`UPDATE checkout_capture_holds SET operation_id=${mismatch === "operation" ? `${f.id}-old` : f.id},thread_id=${mismatch === "thread" ? "other" : f.id},generation=${mismatch === "generation" ? 1 : 2} WHERE checkout_root=${f.main}`;
        yield* Effect.flip(f.access.assertAvailable({ path: f.main }));
        yield* Effect.flip(f.access.begin({ paths: [f.main], kind: "write-file" }));
        yield* Effect.flip(fence.assertProjectMutable(f.id));
      }
    }),
  );

  it.effect("permits admitted file subpaths during drain without granting ancestor paths", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE thread_checkout_claims SET phase='released' WHERE operation_id=${f.id}`;
      const capture = makeCheckoutCapture(f.sql);
      const parent = yield* capture.admit({
        threadId: `${f.id}-other`,
        workId: "turn",
        kind: "provider",
        checkoutRoot: f.main,
      });
      const owner = {
        threadId: f.id,
        operationId: f.id,
        generation: 2,
        environmentId: "destination",
      };
      yield* capture.acquireDrain({ ...owner, checkoutRoot: f.main, gitCommonRoot: f.main });
      const file = f.path.join(f.main, "new", "file");
      const operation = yield* f.access
        .begin({ paths: [file], kind: "write-file" })
        .pipe(Effect.provideService(CheckoutAdmission, parent.admissionId));
      yield* f.access.complete(operation);
      yield* Effect.flip(
        f.access
          .begin({ paths: [f.root], kind: "write-file" })
          .pipe(Effect.provideService(CheckoutAdmission, parent.admissionId)),
      );
      const unrelated = yield* f.access
        .begin({ paths: [f.sibling], kind: "write-file" })
        .pipe(Effect.provideService(CheckoutAdmission, parent.admissionId));
      yield* f.access.complete(unrelated);
      yield* capture.complete(parent.admissionId);
      yield* Effect.flip(
        f.access
          .begin({ paths: [file], kind: "write-file" })
          .pipe(Effect.provideService(CheckoutAdmission, parent.admissionId)),
      );
      yield* capture.enterCapturing(owner);
      yield* Effect.flip(f.access.begin({ paths: [file], kind: "write-file" }));
    }),
  );
  it.effect("keeps SQL available while filesystem admission is paused", () =>
    Effect.gen(function* () {
      const f = yield* pausedAdmission();
      const pending = yield* f.access
        .begin({ paths: [f.main], kind: "vcs" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(f.preparing);
      yield* f.sql`UPDATE projection_projects SET title = 'Unrelated change' WHERE project_id = ${f.id}`;
      yield* Deferred.succeed(f.resume, undefined);
      const operationId = yield* Fiber.join(pending);
      yield* f.access.complete(operationId);
    }),
  );
  it.effect("rechecks a reservation created during filesystem preparation", () =>
    Effect.gen(function* () {
      const f = yield* pausedAdmission();
      const pending = yield* f.access
        .begin({ paths: [f.main], kind: "write-file" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(f.preparing);
      yield* f.sql`UPDATE thread_checkout_claims SET phase = 'reserved', checkout_path = ${f.main}
        WHERE operation_id = ${f.id}`;
      yield* Deferred.succeed(f.resume, undefined);
      const result = yield* Fiber.join(pending);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("reserved");
      expect(yield* f.sql`SELECT * FROM checkout_operations`).toEqual([]);
    }),
  );
  it.effect("includes a project alias registered during filesystem preparation", () =>
    Effect.gen(function* () {
      const f = yield* pausedAdmission();
      const alias = f.path.join(f.root, "alias");
      yield* f.fs.symlink(f.main, alias);
      const pending = yield* f.access
        .begin({ paths: [f.main], kind: "write-file" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(f.preparing);
      const aliasId = `${f.id}-alias`;
      yield* f.sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${aliasId},'Alias',${alias},'[]','2026-10-05T10:00:00.000Z','2026-10-05T10:00:00.000Z')`;
      yield* Deferred.succeed(f.resume, undefined);
      const operationId = yield* Fiber.join(pending);
      expect(
        yield* f.sql`SELECT project_id AS id FROM checkout_operation_projects
          WHERE operation_id = ${operationId} ORDER BY project_id`,
      ).toEqual([{ id: f.id }, { id: aliasId }]);
      yield* f.access.complete(operationId);
    }),
  );
  it.effect("bounds preparation retries when project paths keep changing", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE thread_checkout_claims SET phase = 'released' WHERE operation_id = ${f.id}`;
      const requested = f.path.join(f.root, "operation");
      yield* f.fs.makeDirectory(requested);
      let preparations = 0;
      const access = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          realPath: (input) =>
            Effect.gen(function* () {
              if (input === requested) {
                preparations++;
                yield* f.sql`UPDATE projection_projects
                  SET workspace_root = ${preparations % 2 === 1 ? f.sibling : f.main}
                  WHERE project_id = ${f.id}`;
              }
              return yield* f.fs.realPath(input);
            }),
        }),
      );
      const error = yield* Effect.flip(access.begin({ paths: [requested], kind: "write-file" }));
      expect(error.retryable).toBe(true);
      expect(preparations).toBe(3);
      expect(yield* f.sql`SELECT * FROM checkout_operations`).toEqual([]);
    }),
  );
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
