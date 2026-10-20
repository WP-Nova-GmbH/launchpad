import { make as makeCheckoutAccess } from "../workspace/CheckoutAccess.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProcessRunner, layer as ProcessRunnerLayer } from "../processRunner.ts";
import { makeThreadCheckoutInstaller } from "./ThreadCheckoutInstall.ts";
import { makeThreadCheckoutClaims } from "./ThreadCheckoutClaim.ts";
import { exportThreadWorkspace, importThreadWorkspace } from "./ThreadWorkspaceTransfer.ts";
import { makeThreadExecutionRelay } from "./ThreadExecutionRelay.ts";

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_checkout_claim_projects`;
  yield* sql`DELETE FROM thread_checkout_claims`;
  yield* sql`DELETE FROM thread_execution_work`;
  yield* sql`DELETE FROM thread_execution_fences`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "thread-checkout-claim-" }),
  );
  const source = path.join(root, "source"),
    destination = path.join(root, "destination");
  yield* fs.makeDirectory(source);
  const git = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
    const result = yield* runner.run({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", ...args],
      cwd,
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "0",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@localhost",
      },
    });
    if (result.code !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout.trim();
  });
  yield* git(source, ["init", "-b", "work"]);
  yield* fs.writeFileString(path.join(source, "README.md"), "base\n");
  yield* fs.writeFileString(path.join(source, ".gitignore"), "ignored/\n");
  yield* fs.makeDirectory(path.join(source, "nested"));
  yield* fs.writeFileString(path.join(source, "nested", "keep.txt"), "nested base\n");
  yield* git(source, ["add", "."]);
  yield* git(source, ["commit", "-m", "base"]);
  yield* git(root, ["clone", "--no-local", source, destination]);
  const oldHead = yield* git(destination, ["rev-parse", "HEAD"]);
  yield* fs.writeFileString(path.join(source, "README.md"), "incoming\n");
  yield* git(source, ["commit", "-am", "incoming"]);
  const archive = yield* exportThreadWorkspace({
    threadId: "thread",
    workspaceRoot: source,
    artifactRoot: path.join(root, "artifacts"),
  });
  const staged = yield* importThreadWorkspace({
    threadId: "thread",
    manifest: archive.manifest,
    artifactDirectory: archive.directory,
    destinationRoot: path.join(root, "staging"),
  });
  const addProject = Effect.fnUntraced(function* (id: string, workspaceRoot: string) {
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${id}, 'test', ${workspaceRoot}, '[]', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')`;
  });
  const addThread = Effect.fnUntraced(function* (id: string, projectId: string) {
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at)
      VALUES (${id}, ${projectId}, 'test', '{}', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')`;
  });
  yield* addProject("project", destination);
  const fence = makeThreadExecutionFence(sql);
  const enrollment = {
    threadId: "thread",
    projectId: "project",
    environmentId: "destination",
    relayUrl: "https://relay.example",
    generation: 2,
    operationId: "move",
  };
  yield* fence.prepare(enrollment);
  const input = {
    ...enrollment,
    manifestSha256: "a".repeat(64),
    workspace: archive.manifest,
    stagedWorkspaceRoot: staged.workspaceRoot,
    worktreesRoot: path.join(root, "worktrees"),
  };
  return {
    sql,
    fs,
    path,
    root,
    source,
    destination,
    git,
    oldHead,
    staged,
    archive,
    input,
    fence,
    runner,
    claims: makeThreadCheckoutClaims(sql),
    addProject,
    addThread,
  };
});
const layer = Layer.mergeAll(
  SqlitePersistenceMemory,
  ProcessRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer)),
);
it.layer(layer)("destination checkout claims", (it) => {
  it.effect("waits for previously admitted operations before reserving a checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const access = yield* makeCheckoutAccess;
      const operationId = yield* access.begin({ paths: [f.destination], kind: "vcs" });
      expect((yield* Effect.flip(f.claims.reserve(f.input))).message).toContain("operations");
      expect(yield* f.claims.get(f.input.operationId)).toBeNull();
      expect(yield* f.git(f.destination, ["rev-parse", "HEAD"])).toBe(f.oldHead);
      const recovered = makeThreadCheckoutClaims(f.sql);
      yield* Effect.flip(recovered.reserve(f.input));
      yield* access.complete(operationId);
      const claim = yield* recovered.reserve(f.input);
      expect(claim.phase).toBe("reserved");
      yield* Effect.flip(access.begin({ paths: [f.destination], kind: "vcs" }));
    }),
  );
  it.effect("reserves a clean unused main checkout without altering its branch or files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const claim = yield* f.claims.reserve(f.input);
      expect(claim.mode).toBe("main");
      expect(claim.checkoutPath).toBe(f.destination);
      expect(yield* f.git(f.destination, ["rev-parse", "HEAD"])).toBe(f.oldHead);
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe("base\n");
      expect(yield* makeThreadCheckoutClaims(f.sql).reserve(f.input)).toEqual(claim);
      expect((yield* f.claims.beginInstall("move")).phase).toBe("installing");
    }),
  );
  for (const kind of [
    "dirty",
    "untracked",
    "ignored",
    "empty-directory",
    "local-commit",
    "assume-unchanged",
  ] as const) {
    it.effect(`keeps a ${kind} main checkout and reserves a distinct worktree`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        if (kind === "dirty" || kind === "local-commit" || kind === "assume-unchanged") {
          yield* f.fs.writeFileString(f.path.join(f.destination, "README.md"), "local work\n");
          if (kind === "assume-unchanged")
            yield* f.git(f.destination, ["update-index", "--assume-unchanged", "README.md"]);
          if (kind === "local-commit") yield* f.git(f.destination, ["commit", "-am", "local"]);
        } else if (kind === "untracked")
          yield* f.fs.writeFileString(f.path.join(f.destination, "mine.txt"), "keep\n");
        else {
          yield* f.fs.makeDirectory(
            f.path.join(f.destination, kind === "ignored" ? "ignored" : "empty"),
          );
          if (kind === "ignored")
            yield* f.fs.writeFileString(
              f.path.join(f.destination, "ignored", "mine.txt"),
              "keep\n",
            );
        }
        const before = yield* f.git(f.destination, ["status", "--porcelain=v1", "--ignored"]);
        const head = yield* f.git(f.destination, ["rev-parse", "HEAD"]);
        const claim = yield* f.claims.reserve(f.input);
        expect(claim.mode).toBe("worktree");
        expect(claim.branch).toMatch(/^t3code\/move-/);
        expect(yield* f.fs.exists(claim.checkoutPath)).toBe(false);
        expect(yield* f.git(f.destination, ["status", "--porcelain=v1", "--ignored"])).toBe(before);
        expect(yield* f.git(f.destination, ["rev-parse", "HEAD"])).toBe(head);
      }),
    );
  }
  it.effect("blocks new main-checkout work through another project's symlink alias", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const alias = f.path.join(f.root, "alias");
      yield* f.fs.symlink(f.destination, alias);
      yield* f.addProject("alias-project", alias);
      expect((yield* f.claims.reserve(f.input)).mode).toBe("main");
      yield* f.addThread("other", "alias-project");
      expect((yield* Effect.flip(f.fence.assertMutable("other")))._tag).toBe(
        "ThreadExecutionFenceError",
      );
      expect((yield* Effect.flip(f.fence.assertProjectMutable("alias-project")))._tag).toBe(
        "ThreadExecutionFenceError",
      );
      const execution = makeThreadExecutionRelay(f.sql, {
        admit: () => Effect.die("must not admit"),
        complete: () => Effect.void,
      });
      for (const kind of ["provider", "terminal", "setup", "workspace"] as const) {
        expect(
          (yield* Effect.flip(execution.begin({ threadId: "other", workId: "work", kind })))._tag,
        ).toBe("ThreadExecutionFenceError");
      }
      yield* f.addProject("unrelated-project", f.source);
      yield* f.addThread("unrelated", "unrelated-project");
      expect(
        yield* execution.begin({ threadId: "unrelated", workId: "work", kind: "provider" }),
      ).toBe("ordinary");
      yield* f.claims.cancelReservation("move");
      expect(yield* execution.begin({ threadId: "other", workId: "work", kind: "provider" })).toBe(
        "ordinary",
      );
    }),
  );
  it.effect("holds an empty VM checkout reservation if new files appear before installation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f.destination, { recursive: true });
      yield* f.fs.makeDirectory(f.destination);
      const claim = yield* f.claims.reserveFresh(f.input, f.destination);
      expect(claim.mode).toBe("main");
      expect(claim.freshCheckout).toBe(1);
      yield* f.fs.writeFileString(f.path.join(f.destination, "outside-file"), "preserve me");
      expect((yield* Effect.flip(f.claims.beginInstall(f.input.operationId))).message).toContain(
        "changed after reservation",
      );
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "outside-file"))).toBe(
        "preserve me",
      );
      expect((yield* f.claims.get(f.input.operationId))?.phase).toBe("reserved");
    }),
  );
  it.effect(
    "rejects a changed main checkout immediately before installation without overwriting it",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.claims.reserve(f.input);
        yield* f.fs.writeFileString(
          f.path.join(f.destination, "README.md"),
          "edited after reservation\n",
        );
        expect((yield* Effect.flip(f.claims.beginInstall("move"))).message).toContain(
          "changed after reservation",
        );
        expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe(
          "edited after reservation\n",
        );
        expect((yield* f.claims.get("move"))?.phase).toBe("reserved");
      }),
  );
  it.effect(
    "retains an uncertain installation after service restart and rejects silent cancellation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.claims.reserve(f.input);
        yield* f.claims.beginInstall("move");
        const restarted = makeThreadCheckoutClaims(f.sql);
        expect((yield* restarted.get("move"))?.phase).toBe("installing");
        expect((yield* Effect.flip(restarted.beginInstall("move"))).message).toContain("Reconcile");
        expect((yield* Effect.flip(restarted.cancelReservation("move"))).message).toContain(
          "Confirm installed checkout cleanup",
        );
        expect((yield* Effect.flip(f.fence.assertProjectMutable("new-project")))._tag).toBe(
          "ThreadExecutionFenceError",
        );
      }),
  );
  it.effect("allows exactly one worker to start installing and rejects changed move identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.claims.reserve(f.input);
      expect(
        (yield* Effect.flip(f.claims.reserve({ ...f.input, manifestSha256: "b".repeat(64) })))
          .message,
      ).toContain("different move");
      const outcomes = yield* Effect.all(
        [f.claims.beginInstall("move"), f.claims.beginInstall("move")].map(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect((yield* f.claims.get("move"))?.phase).toBe("installing");
    }),
  );
  it.effect(
    "installs a main checkout with staging, ignored files and links while retaining a restorable original",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(f.path.join(f.source, "README.md"), "staged\n");
        yield* f.git(f.source, ["add", "README.md"]);
        yield* f.fs.writeFileString(f.path.join(f.source, "README.md"), "unstaged\n");
        yield* f.fs.makeDirectory(f.path.join(f.source, "ignored"));
        yield* f.fs.writeFileString(f.path.join(f.source, "ignored", "mine.txt"), "ignored data\n");
        yield* f.fs.symlink("README.md", f.path.join(f.source, "readme-link"));
        const archive = yield* exportThreadWorkspace({
          threadId: "thread",
          workspaceRoot: f.source,
          artifactRoot: f.path.join(f.root, "artifacts"),
        });
        const staged = yield* importThreadWorkspace({
          threadId: "thread",
          manifest: archive.manifest,
          artifactDirectory: archive.directory,
          destinationRoot: f.path.join(f.root, "staging"),
        });
        const input = {
          ...f.input,
          workspace: archive.manifest,
          stagedWorkspaceRoot: staged.workspaceRoot,
          artifactDirectory: archive.directory,
          recoveryRoot: f.path.join(f.root, "recovery"),
        };
        const installer = makeThreadCheckoutInstaller(f.sql);
        const installed = yield* installer.install(input);
        expect(installed.mode).toBe("main");
        expect(installed.phase).toBe("installed");
        expect(yield* f.git(f.destination, ["diff", "--cached", "--binary"])).toBe(
          yield* f.git(f.source, ["diff", "--cached", "--binary"]),
        );
        expect(yield* f.git(f.destination, ["diff", "--binary"])).toBe(
          yield* f.git(f.source, ["diff", "--binary"]),
        );
        expect(yield* f.fs.readLink(f.path.join(f.destination, "readme-link"))).toBe("README.md");
        expect(yield* f.fs.readFileString(f.path.join(f.destination, "ignored", "mine.txt"))).toBe(
          "ignored data\n",
        );
        expect(yield* f.git(f.destination, ["remote", "get-url", "origin"])).toBe(f.source);
        expect(installed.backupDirectory).not.toBeNull();
        const manifestText = yield* f.fs.readFileString(
          f.path.join(installed.backupDirectory!, "manifest.json"),
        );
        const original = yield* importThreadWorkspace({
          threadId: "thread",
          manifest: yield* decodeUnknownJson(manifestText),
          artifactDirectory: installed.backupDirectory!,
          destinationRoot: f.path.join(f.root, "recovered"),
        });
        expect(yield* f.git(original.workspaceRoot, ["rev-parse", "HEAD"])).toBe(f.oldHead);
        expect(yield* f.fs.readFileString(f.path.join(original.workspaceRoot, "README.md"))).toBe(
          "base\n",
        );
        expect(yield* installer.install(input)).toEqual(yield* f.claims.get("move"));
      }),
  );
  it.effect("installs into a linked worktree without altering an occupied main checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.addThread("other", "project");
      yield* f.fs.writeFileString(f.path.join(f.destination, "README.md"), "local unsaved work\n");
      const installed = yield* makeThreadCheckoutInstaller(f.sql).install({
        ...f.input,
        artifactDirectory: f.archive.directory,
        recoveryRoot: f.path.join(f.root, "recovery"),
      });
      expect(installed.mode).toBe("worktree");
      expect(yield* f.git(installed.checkoutPath, ["rev-parse", "HEAD"])).toBe(
        f.archive.manifest.head,
      );
      expect(yield* f.git(installed.checkoutPath, ["branch", "--show-current"])).toBe(
        installed.branch,
      );
      expect(yield* f.git(f.destination, ["branch", "--show-current"])).toBe("work");
      expect(yield* f.git(f.destination, ["rev-parse", "HEAD"])).toBe(f.oldHead);
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe(
        "local unsaved work\n",
      );
      yield* f.fence.assertMutable("other");
      expect((yield* f.fence.get("thread"))?.phase).toBe("frozen");
    }),
  );
  it.effect("rejects corrupt incoming files before touching the reserved checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.archive.manifest.files.find((file) => file.kind === "file");
      if (!file || file.kind !== "file") throw new Error("missing fixture file");
      yield* f.fs.writeFileString(
        f.path.join(f.archive.directory, "objects", file.sha256),
        "corrupted",
      );
      yield* Effect.flip(
        makeThreadCheckoutInstaller(f.sql).install({
          ...f.input,
          artifactDirectory: f.archive.directory,
          recoveryRoot: f.path.join(f.root, "recovery"),
        }),
      );
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe("base\n");
      expect(yield* f.git(f.destination, ["rev-parse", "HEAD"])).toBe(f.oldHead);
      expect((yield* f.claims.get("move"))?.phase).toBe("reserved");
    }),
  );
  it.effect("recovers a completed checkout after losing the database completion receipt", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const input = {
        ...f.input,
        artifactDirectory: f.archive.directory,
        recoveryRoot: f.path.join(f.root, "recovery"),
      };
      yield* f.sql`CREATE TRIGGER lose_checkout_receipt BEFORE UPDATE OF phase ON thread_checkout_claims
      WHEN NEW.phase = 'installed' BEGIN SELECT RAISE(ABORT, 'lost completion'); END`;
      yield* Effect.flip(makeThreadCheckoutInstaller(f.sql).install(input));
      expect((yield* f.claims.get("move"))?.phase).toBe("installing");
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe(
        "incoming\n",
      );
      yield* f.sql`DROP TRIGGER lose_checkout_receipt`;
      expect((yield* makeThreadCheckoutInstaller(f.sql).reconcile(input)).phase).toBe("installed");
      expect((yield* f.fence.get("thread"))?.phase).toBe("frozen");
    }),
  );
  it.effect("refuses to adopt changed files after an interrupted installation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const input = {
        ...f.input,
        artifactDirectory: f.archive.directory,
        recoveryRoot: f.path.join(f.root, "recovery"),
      };
      yield* f.sql`CREATE TRIGGER lose_checkout_receipt BEFORE UPDATE OF phase ON thread_checkout_claims
      WHEN NEW.phase = 'installed' BEGIN SELECT RAISE(ABORT, 'lost completion'); END`;
      yield* Effect.flip(makeThreadCheckoutInstaller(f.sql).install(input));
      yield* f.sql`DROP TRIGGER lose_checkout_receipt`;
      yield* f.fs.writeFileString(f.path.join(f.destination, "README.md"), "new local edit\n");
      expect(
        (yield* Effect.flip(makeThreadCheckoutInstaller(f.sql).reconcile(input))).message,
      ).toContain("incomplete or changed");
      expect((yield* f.claims.get("move"))?.phase).toBe("installing");
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe(
        "new local edit\n",
      );
    }),
  );
  it.effect("does not overwrite a file created by an external writer during installation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const input = {
        ...f.input,
        artifactDirectory: f.archive.directory,
        recoveryRoot: f.path.join(f.root, "recovery"),
      };
      const process = ProcessRunner.of({
        run: (request) =>
          Effect.gen(function* () {
            if (request.cwd === f.destination && request.args?.includes("hash-object"))
              yield* f.fs
                .writeFileString(f.path.join(f.destination, "README.md"), "external editor\n")
                .pipe(Effect.orDie);
            return yield* f.runner.run(request);
          }),
      });
      const error = yield* Effect.flip(
        makeThreadCheckoutInstaller(f.sql)
          .install(input)
          .pipe(Effect.provideService(ProcessRunner, process)),
      );
      expect(error.message).toContain("not overwritten");
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe(
        "external editor\n",
      );
      expect((yield* f.claims.get("move"))?.phase).toBe("installing");
      expect((yield* f.claims.get("move"))?.backupDirectory).not.toBeNull();
    }),
  );
  it.effect("cancels an installed main checkout by restoring its original files and branch", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const input = {
        ...f.input,
        artifactDirectory: f.archive.directory,
        recoveryRoot: f.path.join(f.root, "recovery"),
      };
      const installer = makeThreadCheckoutInstaller(f.sql);
      yield* installer.install(input);
      yield* installer.rollback(input);
      yield* installer.rollback(input);
      expect(yield* f.git(f.destination, ["rev-parse", "HEAD"])).toBe(f.oldHead);
      expect(yield* f.git(f.destination, ["status", "--porcelain=v1"])).toBe("");
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe("base\n");
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "nested", "keep.txt"))).toBe(
        "nested base\n",
      );
      expect((yield* f.claims.get("move"))?.releaseReason).toBe("cancelled");
      expect((yield* f.fence.get("thread"))?.phase).toBe("frozen");
    }),
  );
  it.effect("cancels the move's linked worktree while preserving an occupied main checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(f.path.join(f.destination, "README.md"), "local unsaved work\n");
      const input = {
        ...f.input,
        artifactDirectory: f.archive.directory,
        recoveryRoot: f.path.join(f.root, "recovery"),
      };
      const installer = makeThreadCheckoutInstaller(f.sql);
      const installed = yield* installer.install(input);
      yield* installer.rollback(input);
      yield* installer.rollback(input);
      expect(yield* f.fs.exists(installed.checkoutPath)).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe(
        "local unsaved work\n",
      );
      expect((yield* f.claims.get("move"))?.phase).toBe("released");
    }),
  );
  it.effect(
    "keeps both local edits and the recovery copy when cancellation encounters new work",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = {
          ...f.input,
          artifactDirectory: f.archive.directory,
          recoveryRoot: f.path.join(f.root, "recovery"),
        };
        const installer = makeThreadCheckoutInstaller(f.sql);
        const installed = yield* installer.install(input);
        yield* f.fs.writeFileString(
          f.path.join(f.destination, "README.md"),
          "edit after install\n",
        );
        expect((yield* Effect.flip(installer.rollback(input))).message).toContain(
          "new local files or edits",
        );
        expect(yield* f.fs.readFileString(f.path.join(f.destination, "README.md"))).toBe(
          "edit after install\n",
        );
        expect(yield* f.fs.exists(installed.backupDirectory!)).toBe(true);
        expect((yield* f.claims.get("move"))?.phase).toBe("installed");
      }),
  );
  for (const mode of ["main", "worktree"] as const)
    it.effect(`retries a ${mode} rollback after losing its completion receipt`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        if (mode === "worktree") yield* f.addThread("other", "project");
        const input = {
          ...f.input,
          artifactDirectory: f.archive.directory,
          recoveryRoot: f.path.join(f.root, "recovery"),
        };
        const installer = makeThreadCheckoutInstaller(f.sql);
        yield* installer.install(input);
        yield* f.sql`CREATE TRIGGER lose_rollback_receipt BEFORE UPDATE OF phase ON thread_checkout_claims
      WHEN NEW.phase = 'released' BEGIN SELECT RAISE(ABORT, 'lost completion'); END`;
        yield* Effect.flip(installer.rollback(input));
        expect((yield* f.claims.get("move"))?.phase).toBe("rolling-back");
        yield* f.sql`DROP TRIGGER lose_rollback_receipt`;
        yield* makeThreadCheckoutInstaller(f.sql).rollback(input);
        expect((yield* f.claims.get("move"))?.releaseReason).toBe("cancelled");
        expect(yield* f.git(f.destination, ["rev-parse", "HEAD"])).toBe(f.oldHead);
      }),
    );
});
