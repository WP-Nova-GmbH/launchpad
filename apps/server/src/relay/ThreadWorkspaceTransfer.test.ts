import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { ThreadId } from "@t3tools/contracts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import { ProcessRunner, layer as ProcessRunnerLayer } from "../processRunner.ts";
import { exportThreadWorkspace, importThreadWorkspace } from "./ThreadWorkspaceTransfer.ts";
import { workspaceFileHash } from "./ThreadWorkspaceFiles.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "thread-workspace-transfer-" }),
  );
  const source = path.join(root, "source");
  yield* fs.makeDirectory(source);
  const git = Effect.fnUntraced(function* (args: ReadonlyArray<string>, cwd = source) {
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
  yield* git(["init", "-b", "work"]);
  yield* fs.writeFileString(path.join(source, "README.md"), "committed\n");
  yield* fs.writeFileString(
    path.join(source, ".gitignore"),
    "ignored/\nnode_modules/\n.t3/\n*.sqlite*\n",
  );
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "base"]);
  const head = yield* git(["rev-parse", "HEAD"]);
  const ownRef = checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1);
  const otherRef = checkpointRefForThreadTurn(ThreadId.make("thread-other"), 1);
  yield* git(["update-ref", ownRef, head]);
  yield* git(["checkout", "-b", "unrelated"]);
  yield* fs.writeFileString(path.join(source, "unrelated-secret.txt"), "must not be in artifact\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "other thread"]);
  const unrelatedCommit = yield* git(["rev-parse", "HEAD"]);
  yield* git(["update-ref", otherRef, unrelatedCommit]);
  yield* git(["checkout", "work"]);
  yield* fs.writeFileString(path.join(source, "README.md"), "staged\n");
  yield* git(["add", "README.md"]);
  yield* fs.writeFileString(path.join(source, "README.md"), "unstaged\n");
  yield* fs.makeDirectory(path.join(source, "ignored"));
  yield* fs.writeFileString(path.join(source, "ignored", "local.txt"), "keep ignored data\n");
  for (const directory of ["node_modules", ".t3"]) {
    yield* fs.makeDirectory(path.join(source, directory));
    yield* fs.writeFileString(path.join(source, directory, "private.txt"), "must not be copied");
  }
  yield* fs.writeFileString(
    path.join(source, ".git", "credentials"),
    "never copy git configuration",
  );
  const input = {
    threadId: "thread-1",
    workspaceRoot: source,
    artifactRoot: path.join(root, "artifacts"),
  };
  const request = (artifact: Effect.Success<ReturnType<typeof exportThreadWorkspace>>) => ({
    threadId: input.threadId,
    manifest: artifact.manifest,
    artifactDirectory: artifact.directory,
    destinationRoot: path.join(root, "destinations"),
  });
  return {
    root,
    source,
    fs,
    path,
    runner,
    git,
    head,
    ownRef,
    otherRef,
    unrelatedCommit,
    input,
    request,
  };
});
const testLayer = ProcessRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer));
it.layer(testLayer)("portable workspace", (it) => {
  it.effect(
    "keeps committed, staged, unstaged, ignored and executable files after deleting the source",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(f.path.join(f.source, "run.sh"), "#!/bin/sh\necho hi\n", {
          mode: 0o755,
        });
        yield* f.fs.symlink("README.md", f.path.join(f.source, "readme-link"));
        const staged = yield* f.git(["diff", "--cached", "--binary"]);
        const unstaged = yield* f.git(["diff", "--binary"]);
        const artifact = yield* exportThreadWorkspace(f.input);
        yield* f.fs.remove(f.source, { recursive: true });
        const imported = yield* importThreadWorkspace(f.request(artifact));
        expect(yield* f.git(["rev-parse", "HEAD"], imported.workspaceRoot)).toBe(f.head);
        expect(yield* f.git(["branch", "--show-current"], imported.workspaceRoot)).toBe("work");
        expect(yield* f.git(["diff", "--cached", "--binary"], imported.workspaceRoot)).toBe(staged);
        expect(yield* f.git(["diff", "--binary"], imported.workspaceRoot)).toBe(unstaged);
        expect(
          yield* f.fs.readFileString(f.path.join(imported.workspaceRoot, "ignored/local.txt")),
        ).toBe("keep ignored data\n");
        expect(yield* f.fs.readLink(f.path.join(imported.workspaceRoot, "readme-link"))).toBe(
          "README.md",
        );
        expect(
          (yield* f.fs.stat(f.path.join(imported.workspaceRoot, "run.sh"))).mode & 0o111,
        ).not.toBe(0);
        for (const excluded of [
          "node_modules",
          ".t3",
          ".git/credentials",
          "unrelated-secret.txt",
        ]) {
          expect(yield* f.fs.exists(f.path.join(imported.workspaceRoot, excluded))).toBe(false);
        }
        expect(yield* f.git(["rev-parse", f.ownRef], imported.workspaceRoot)).toBe(f.head);
        const missing = yield* f.runner.run({
          command: "git",
          args: ["cat-file", "-e", f.unrelatedCommit],
          cwd: imported.workspaceRoot,
        });
        expect(missing.code).not.toBe(0);
        expect(
          yield* f.git(["for-each-ref", "--format=%(refname)"], imported.workspaceRoot),
        ).not.toContain(f.otherRef);
      }),
  );
  it.effect(
    "exports a linked worktree without exporting its common repository's unrelated branch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const linked = f.path.join(f.root, "linked");
        yield* f.git(["worktree", "add", "-b", "linked", linked, f.head]);
        yield* f.fs.writeFileString(f.path.join(linked, "README.md"), "linked edits\n");
        const artifact = yield* exportThreadWorkspace({ ...f.input, workspaceRoot: linked });
        const imported = yield* importThreadWorkspace(f.request(artifact));
        expect(yield* f.fs.readFileString(f.path.join(imported.workspaceRoot, "README.md"))).toBe(
          "linked edits\n",
        );
        expect(yield* f.git(["branch", "--show-current"], imported.workspaceRoot)).toBe("linked");
        expect(yield* f.git(["branch", "--list"], imported.workspaceRoot)).not.toContain(
          "unrelated",
        );
      }),
  );
  it.effect(
    "preserves split-index and intent-to-add state without requiring source index objects",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(f.path.join(f.source, "new.txt"), "not staged yet\n");
        yield* f.git(["add", "--intent-to-add", "new.txt"]);
        yield* f.git(["update-index", "--split-index"]);
        const status = yield* f.git(["status", "--porcelain=v1"]);
        const artifact = yield* exportThreadWorkspace(f.input);
        const imported = yield* importThreadWorkspace(f.request(artifact));
        expect(yield* f.git(["status", "--porcelain=v1"], imported.workspaceRoot)).toBe(status);
      }),
  );
  it.effect("supports a detached HEAD", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.git(["checkout", "--detach"]);
      const artifact = yield* exportThreadWorkspace(f.input);
      const imported = yield* importThreadWorkspace(f.request(artifact));
      expect(yield* f.git(["rev-parse", "HEAD"], imported.workspaceRoot)).toBe(f.head);
      expect(yield* f.git(["branch", "--show-current"], imported.workspaceRoot)).toBe("");
    }),
  );
  it.effect("backs up committed SQLite WAL data and excludes an unfinished transaction", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.path.join(f.source, "data.sqlite");
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(file)),
        (db) => Effect.sync(() => db.close()),
      );
      db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN IMMEDIATE; INSERT INTO messages VALUES ('uncommitted');",
      );
      const artifact = yield* exportThreadWorkspace(f.input);
      db.exec("ROLLBACK");
      const imported = yield* importThreadWorkspace(f.request(artifact));
      const restored = new NodeSqlite.DatabaseSync(
        f.path.join(imported.workspaceRoot, "data.sqlite"),
        {
          readOnly: true,
        },
      );
      try {
        expect(
          restored
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
        ).toEqual(["committed"]);
        expect(restored.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally {
        restored.close();
      }
      expect(
        artifact.manifest.files.some((file) => /data.sqlite-(wal|shm|journal)$/.test(file.path)),
      ).toBe(false);
    }),
  );
  for (const part of ["bundle", "index", "object"] as const) {
    it.effect(`rejects a corrupt ${part} and retains existing destinations`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const artifact = yield* exportThreadWorkspace(f.input);
        const request = f.request(artifact);
        yield* f.fs.makeDirectory(request.destinationRoot);
        yield* f.fs.writeFileString(
          f.path.join(request.destinationRoot, "keep"),
          "existing checkout",
        );
        const file = artifact.manifest.files.find((file) => file.kind === "file")!;
        if (file.kind !== "file") throw new Error("no fixture file");
        const target =
          part === "bundle"
            ? "repository.bundle"
            : part === "index"
              ? "index"
              : `objects/${file.sha256}`;
        yield* f.fs.writeFileString(f.path.join(artifact.directory, target), "corrupt");
        yield* Effect.flip(importThreadWorkspace(request));
        expect(yield* f.fs.readDirectory(request.destinationRoot)).toEqual(["keep"]);
        expect(yield* f.fs.readFileString(f.path.join(f.source, "README.md"))).toBe("unstaged\n");
      }),
    );
  }
  for (const kind of [
    "escape",
    "absolute",
    "case-collision",
    "nested-repository",
    "lfs",
    "git-lock",
  ] as const) {
    it.effect(`blocks ${kind} before producing a transferable artifact`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        if (kind === "escape" || kind === "absolute")
          yield* f.fs.symlink(
            kind === "escape" ? "../outside" : "/etc/passwd",
            f.path.join(f.source, "bad-link"),
          );
        if (kind === "case-collision") {
          yield* f.fs.writeFileString(f.path.join(f.source, "readme.MD"), "collision");
          // Mac's default filesystem already aliases this spelling; exercise the manifest separately below.
          if (
            (yield* f.fs.readDirectory(f.source)).filter(
              (name) => name.toLowerCase() === "readme.md",
            ).length < 2
          )
            return;
        }
        if (kind === "nested-repository") {
          yield* f.fs.makeDirectory(f.path.join(f.source, "nested"));
          yield* f.git(["init", "nested"]);
        }
        if (kind === "lfs")
          yield* f.fs.writeFileString(
            f.path.join(f.source, ".gitattributes"),
            "README.md filter=lfs\n",
          );
        if (kind === "git-lock")
          yield* f.fs.writeFileString(f.path.join(f.source, ".git/index.lock"), "lock");
        yield* Effect.flip(exportThreadWorkspace(f.input));
        expect(yield* f.fs.readFileString(f.path.join(f.source, ".git/credentials"))).toBe(
          "never copy git configuration",
        );
      }),
    );
  }
  it.effect(
    "rejects traversal, duplicate paths, case collisions and entries under symlink parents on import",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const artifact = yield* exportThreadWorkspace(f.input);
        for (const extra of [
          { kind: "directory", path: "../outside" },
          { kind: "directory", path: ".git/hooks" },
          { kind: "directory", path: "README.md" },
          { kind: "directory", path: "readme.MD" },
          {
            kind: "file",
            path: "missing/child",
            sha256: "a".repeat(64),
            size: 1,
            executable: false,
          },
        ]) {
          yield* Effect.flip(
            importThreadWorkspace({
              ...f.request(artifact),
              manifest: { ...artifact.manifest, files: [...artifact.manifest.files, extra] },
            }),
          );
        }
        expect(yield* f.fs.exists(f.request(artifact).destinationRoot)).toBe(false);
      }),
  );
  it.effect(
    "rejects a manifest with another thread's checkpoint even when the bundle hash is valid",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const artifact = yield* exportThreadWorkspace(f.input);
        yield* Effect.flip(
          importThreadWorkspace({
            ...f.request(artifact),
            manifest: { ...artifact.manifest, checkpoints: [{ ref: f.otherRef, commit: f.head }] },
          }),
        );
        expect(yield* f.fs.exists(f.request(artifact).destinationRoot)).toBe(false);
      }),
  );
  it.effect(
    "detects a workspace writer during Git bundle creation and removes only the unpublished artifact",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const intercept: ProcessRunner["Service"] = {
          run: (input) =>
            f.runner
              .run(input)
              .pipe(
                Effect.tap(() =>
                  input.args.includes("bundle") && input.args.includes("create")
                    ? f.fs
                        .writeFileString(f.path.join(f.source, "README.md"), "external edit\n")
                        .pipe(Effect.orDie)
                    : Effect.void,
                ),
              ),
        };
        const error = yield* Effect.flip(
          exportThreadWorkspace(f.input).pipe(Effect.provideService(ProcessRunner, intercept)),
        );
        expect(error._tag).toBe("ThreadWorkspaceTransferError");
        expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(f.source, "README.md"))).toBe(
          "external edit\n",
        );
      }),
  );
  it.effect("binds the copied index to the Git tree even if its transport hash was replaced", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const artifact = yield* exportThreadWorkspace(f.input);
      yield* f.git(["add", "README.md"]);
      yield* f.fs.copyFile(
        f.path.join(f.source, ".git/index"),
        f.path.join(artifact.directory, "index"),
      );
      const index = yield* workspaceFileHash(f.path.join(artifact.directory, "index"));
      yield* Effect.flip(
        importThreadWorkspace({
          ...f.request(artifact),
          manifest: { ...artifact.manifest, index },
        }),
      );
      expect(yield* f.fs.readDirectory(f.request(artifact).destinationRoot)).toEqual([]);
    }),
  );
  for (const action of ["export", "import"] as const) {
    it.effect(`cleans an interrupted ${action} without removing the original workspace`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const artifact = action === "import" ? yield* exportThreadWorkspace(f.input) : null;
        const entered = yield* Deferred.make<void>();
        const intercept: ProcessRunner["Service"] = {
          run: (input) =>
            input.args.includes(action === "export" ? "commit-tree" : "fetch")
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : f.runner.run(input),
        };
        const operation: Effect.Effect<
          void,
          | Effect.Error<ReturnType<typeof exportThreadWorkspace>>
          | Effect.Error<ReturnType<typeof importThreadWorkspace>>,
          FileSystem.FileSystem | Path.Path | ProcessRunner
        > = artifact
          ? importThreadWorkspace(f.request(artifact)).pipe(Effect.asVoid)
          : exportThreadWorkspace(f.input).pipe(Effect.asVoid);
        const fiber = yield* operation.pipe(
          Effect.provideService(ProcessRunner, intercept),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(
          yield* f.fs.readDirectory(
            artifact ? f.request(artifact).destinationRoot : f.input.artifactRoot,
          ),
        ).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(f.source, "README.md"))).toBe("unstaged\n");
        if (artifact)
          expect(yield* f.fs.exists(f.path.join(artifact.directory, "manifest.json"))).toBe(true);
      }),
    );
  }
  it.effect("rejects files beneath a symlink parent before any destination write", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const artifact = yield* exportThreadWorkspace(f.input);
      const files = [
        ...artifact.manifest.files,
        { kind: "symlink", path: "alias", target: "ignored" },
        { kind: "directory", path: "alias/subdirectory" },
      ];
      yield* Effect.flip(
        importThreadWorkspace({
          ...f.request(artifact),
          manifest: { ...artifact.manifest, files },
        }),
      );
      expect(yield* f.fs.exists(f.request(artifact).destinationRoot)).toBe(false);
    }),
  );
  it.effect("rejects an artifact root symlinked into the checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = f.path.join(f.root, "artifact-link");
      yield* f.fs.symlink(f.source, link);
      yield* Effect.flip(exportThreadWorkspace({ ...f.input, artifactRoot: link }));
      expect(
        (yield* f.fs.readDirectory(f.source)).some((name) => name.startsWith("workspace-")),
      ).toBe(false);
    }),
  );
});
