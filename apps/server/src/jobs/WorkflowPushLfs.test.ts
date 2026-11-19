import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { workflowPushNeedsLfsUpload } from "./WorkflowPushLfs.ts";

const realGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-lfs-" })),
  Layer.provide(VcsProcess.layerLocal),
  Layer.provideMerge(NodeServices.layer),
);

const makeRepo = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-lfs-git-" });
  const git = (args: ReadonlyArray<string>) =>
    driver
      .execute({
        operation: "WorkflowPushLfs.test.git",
        cwd,
        args,
        env: GitVcsDriver.workflowGitEnvironment,
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@example.test"]);
  yield* git(["config", "commit.gpgsign", "false"]);
  yield* git(["config", "core.hooksPath", ".git/hooks"]);
  const write = (path: string, contents: string) => fs.writeFileString(`${cwd}/${path}`, contents);
  const commit = Effect.fnUntraced(function* (message: string) {
    yield* git(["add", "--all"]);
    yield* git(["commit", "-m", message]);
    return yield* git(["rev-parse", "HEAD"]);
  });
  return { cwd, driver, git, write, commit };
});

const lfsPointer = (hashDigit: string) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${hashDigit.repeat(64)}\nsize 123\n`;

it.effect("only detects LFS pointers in newly published Git history", () =>
  Effect.gen(function* () {
    const { cwd, driver, git, write, commit } = yield* makeRepo();
    yield* write("base.bin", lfsPointer("a"));
    const baseSha = yield* commit("repository base");
    const needsUpload = (commitSha: string, publishedSha: string | null = null) =>
      workflowPushNeedsLfsUpload(driver, { cwd, commitSha, baseSha, publishedSha });

    yield* write("copied.bin", lfsPointer("a"));
    yield* write("regular.txt", "Regular change\n");
    yield* write("sample.txt", `${lfsPointer("b")}${"x".repeat(1024)}`);
    const withoutNewPointer = yield* commit("copy a known pointer and add regular files");
    assert.isFalse(yield* needsUpload(withoutNewPointer));

    yield* write("new.bin", lfsPointer("b"));
    const withNewPointer = yield* commit("introduce an LFS pointer");
    assert.isTrue(yield* needsUpload(withNewPointer));

    yield* git(["rm", "new.bin"]);
    const removedPointer = yield* commit("remove pointer from final tree");
    assert.isTrue(yield* needsUpload(removedPointer));
    assert.isFalse(yield* needsUpload(removedPointer, withNewPointer));
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("detects an LFS pointer to a zero-byte file", () =>
  Effect.gen(function* () {
    const { cwd, driver, write, commit } = yield* makeRepo();
    yield* write("base.txt", "Base\n");
    const baseSha = yield* commit("repository base");
    const needsUpload = (commitSha: string) =>
      workflowPushNeedsLfsUpload(driver, { cwd, commitSha, baseSha, publishedSha: null });

    yield* write("empty.txt", "");
    assert.isFalse(yield* needsUpload(yield* commit("add an ordinary empty file")));

    yield* write(
      "empty.bin",
      "version https://git-lfs.github.com/spec/v1\noid sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nsize 0\n",
    );
    assert.isTrue(yield* needsUpload(yield* commit("add an LFS pointer for an empty file")));
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("fails the check when Git returns truncated output or incomplete metadata", () =>
  Effect.gen(function* () {
    const { cwd, driver, write, commit } = yield* makeRepo();
    yield* write("base.txt", "Base\n");
    const baseSha = yield* commit("repository base");
    yield* write("new.bin", lfsPointer("a"));
    const commitSha = yield* commit("introduce an LFS pointer");
    const input = { cwd, baseSha, commitSha, publishedSha: null };

    const truncated = yield* workflowPushNeedsLfsUpload(
      {
        ...driver,
        execute: (args) =>
          driver.execute(args).pipe(Effect.map((result) => ({ ...result, stdoutTruncated: true }))),
      },
      input,
    ).pipe(Effect.flip);
    assert.match(truncated.detail, /Could not read the Git objects/);

    const incomplete = yield* workflowPushNeedsLfsUpload(
      {
        ...driver,
        execute: (args) =>
          driver
            .execute(args)
            .pipe(
              Effect.map((result) =>
                args.stdin === undefined ? result : { ...result, stdout: "" },
              ),
            ),
      },
      input,
    ).pipe(Effect.flip);
    assert.match(incomplete.detail, /incomplete object metadata/);
  }).pipe(Effect.provide(realGitLayer)),
);
