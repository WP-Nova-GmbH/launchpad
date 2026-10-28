import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { RelayThreadVmGitMetadata } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ProcessRunner, layer as RunnerLayer } from "../processRunner.ts";
import { prepareThreadVmGitConfig, publishThreadVmGitConfig } from "./ThreadVmGitConfig.ts";
import { THREAD_VM_GIT_CREDENTIAL_HELPER } from "../vcs/threadVmCredentials.ts";

const environment = RunnerLayer.pipe(Layer.provideMerge(NodeServices.layer));
const bot: RelayThreadVmGitMetadata = {
  status: "ready",
  appId: "12",
  appSlug: "launchpad",
  botUserId: 123,
  name: "launchpad[bot]",
  email: "123+launchpad[bot]@users.noreply.github.com",
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    runner = yield* ProcessRunner,
    root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "vm-git-config-" }));
  const run = (args: ReadonlyArray<string>, stdin?: string) =>
    runner.run({
      command: "git",
      cwd: root,
      args,
      ...(stdin ? { stdin } : {}),
      timeout: "10 seconds",
      maxOutputBytes: 16_384,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "0",
      },
    });
  const git = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const result = yield* run(args);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trimEnd();
  });
  yield* git(["init", "--initial-branch=feature"]);
  const setup = (...metadata: [] | [RelayThreadVmGitMetadata | undefined]) =>
    prepareThreadVmGitConfig(
      root,
      "github.com/acme/project",
      metadata.length ? metadata[0] : bot,
    ).pipe(Effect.tap(publishThreadVmGitConfig));
  return { fs, root, run, git, setup };
});

describe("VM Git configuration", () => {
  it.effect("preserves an included explicit PR base while replacing local branch tracking", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture,
          included = `${f.root}/included-base`;
        yield* f.fs.writeFileString(
          included,
          '[branch "feature"]\n\tgh-merge-base = develop\n\tremote = origin\n',
        );
        yield* f.git(["config", "include.path", included]);
        yield* f.git(["config", "branch.feature.merge", "refs/heads/main"]);
        yield* f.setup();
        assert.equal(yield* f.git(["config", "branch.feature.gh-merge-base"]), "develop");
        assert.equal(
          yield* f.git(["config", "--get-all", "branch.feature.merge"]),
          "refs/heads/feature",
        );
        assert.equal(yield* f.git(["config", "include.path"]), included);
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect(
    "removes imported URL-specific account helpers and resets helpers from unrelated includes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            included = `${f.root}/included-config`;
          const broad = "!printf 'username=personal\\npassword=broad-account\\n'";
          yield* f.fs.writeFileString(
            included,
            `[credential]\n\thelper = ${broad}\n[custom]\n\tfromInclude = preserved\n`,
          );
          yield* f.git(["config", "include.path", included]);
          yield* f.git(["config", "credential.https://github.com/acme/project.git.helper", broad]);
          yield* f.git([
            "config",
            "credential.https://github.com/acme/project.git.useHttpPath",
            "false",
          ]);
          yield* f.setup();
          assert.equal(yield* f.git(["config", "custom.fromInclude"]), "preserved");
          const reply = yield* f.run(
            ["credential", "fill"],
            "protocol=https\nhost=github.com\npath=acme/project.git\n\n",
          );
          assert.notEqual(reply.code, 0);
          assert.notInclude(reply.stdout, "broad-account");
          assert.notInclude(reply.stdout, "personal");
        }),
      ).pipe(Effect.provide(environment)),
  );

  it.effect(
    "rejects included origin/credential overrides and worktree-local configuration explicitly",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            included = `${f.root}/included-config`;
          yield* f.git(["config", "include.path", included]);
          for (const settings of [
            '[branch "feature"]\n\tmerge = refs/heads/main\n',
            '[remote "origin"]\n\tpush = HEAD:refs/heads/main\n',
            '[credential "https://github.com/acme/project.git"]\n\thelper = store\n',
          ]) {
            yield* f.fs.writeFileString(included, settings);
            assert.include(
              (yield* f.setup().pipe(Effect.flip)).message,
              "included Git configuration",
            );
          }
          yield* f.fs.writeFileString(included, "[custom]\n\tkeep = yes\n");
          yield* f.git(["config", "extensions.worktreeConfig", "true"]);
          assert.include((yield* f.setup().pipe(Effect.flip)).message, "extensions.worktreeConfig");
        }),
      ).pipe(Effect.provide(environment)),
  );

  for (const enabled of ["2", "-1"]) {
    it.effect(`rejects worktree configuration enabled by Git's numeric boolean ${enabled}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.git(["config", "extensions.worktreeConfig", enabled]);
          yield* f.git(["config", "--worktree", "user.name", "Personal Author"]);
          yield* f.git(["config", "--worktree", "credential.helper", "store"]);
          assert.equal(yield* f.git(["config", "--bool", "extensions.worktreeConfig"]), "true");
          assert.equal(yield* f.git(["config", "user.name"]), "Personal Author");
          const original = yield* f.fs.readFileString(`${f.root}/.git/config`),
            worktree = yield* f.fs.readFileString(`${f.root}/.git/config.worktree`);
          assert.include((yield* f.setup().pipe(Effect.flip)).message, "extensions.worktreeConfig");
          assert.equal(yield* f.fs.readFileString(`${f.root}/.git/config`), original);
          assert.equal(yield* f.fs.readFileString(`${f.root}/.git/config.worktree`), worktree);
          assert.isFalse(yield* f.fs.exists(`${f.root}/.git/config.lock`));
        }),
      ).pipe(Effect.provide(environment)),
    );
  }

  it.effect("allows worktree configuration disabled with Git's numeric boolean zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.git(["config", "extensions.worktreeConfig", "0"]);
        yield* f.setup();
        assert.equal(yield* f.git(["config", "user.name"]), bot.name);
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect(
    "creates ordinary bot commits while preserving staged/dirty files and unrelated config",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.git(["config", "user.name", "Personal"]);
          yield* f.git(["config", "user.email", "personal@example.com"]);
          yield* f.git(["config", "commit.gpgsign", "true"]);
          yield* f.git(["config", "gpg.program", "/missing/workstation-signer"]);
          yield* f.git(["config", "custom.keep", "unchanged"]);
          yield* f.fs.writeFileString(`${f.root}/staged`, "staged");
          yield* f.git(["add", "staged"]);
          yield* f.fs.writeFileString(`${f.root}/dirty`, "dirty");
          const before = yield* f.git(["status", "--porcelain"]);
          yield* f.setup();
          assert.equal(yield* f.git(["status", "--porcelain"]), before);
          assert.equal(yield* f.git(["branch", "--show-current"]), "feature");
          assert.equal(yield* f.git(["config", "custom.keep"]), "unchanged");
          yield* f.git(["commit", "-m", "Bot commit"]);
          assert.equal(
            yield* f.git(["show", "-s", "--format=%an <%ae>|%cn <%ce>"]),
            `${bot.name} <${bot.email}>|${bot.name} <${bot.email}>`,
          );
          assert.equal(yield* f.git(["config", "credential.useHttpPath"]), "true");
          assert.equal(
            yield* f.git(["remote", "get-url", "origin"]),
            "https://github.com/acme/project.git",
          );
          assert.deepEqual(
            (yield* f.git(["config", "--get-all", "credential.helper"])).split("\n"),
            ["", THREAD_VM_GIT_CREDENTIAL_HELPER],
          );
        }),
      ).pipe(Effect.provide(environment)),
  );

  it.effect("pushes and then pulls the working branch rather than its former main upstream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.setup();
        yield* f.fs.writeFileString(`${f.root}/file`, "first");
        yield* f.git(["add", "file"]);
        yield* f.git(["commit", "-m", "first"]);
        const origin = `${f.root}/remote.git`;
        yield* f.git(["init", "--bare", origin]);
        yield* f.git(["config", "branch.feature.remote", "origin"]);
        yield* f.git(["config", "branch.feature.merge", "refs/heads/main"]);
        yield* f.git(["config", "branch.feature.pushRemote", "stale-personal"]);
        yield* f.git(["config", "remote.origin.push", "HEAD:refs/heads/wrong"]);
        yield* f.setup();
        assert.equal(yield* f.git(["config", "branch.feature.gh-merge-base"]), "main");
        // Git's local URL rewrite substitutes only transport; exercise ordinary push/pull defaults.
        yield* f.git(["config", `url.${origin}.insteadOf`, "https://github.com/acme/project.git"]);
        yield* f.git(["push"]);
        yield* f.fs.writeFileString(`${f.root}/file`, "second");
        yield* f.git(["add", "file"]);
        yield* f.git(["commit", "-m", "second"]);
        yield* f.git(["push"]);
        yield* f.git(["reset", "--hard", "HEAD~1"]);
        yield* f.git(["pull", "--ff-only"]);
        assert.equal(yield* f.fs.readFileString(`${f.root}/file`), "second");
        assert.equal(yield* f.git(["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feature");
        assert.equal(
          (yield* f.run(["show-ref", "--verify", "refs/remotes/origin/main"])).code,
          128,
        );
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect("tracks a branch created after setup on its first push and immediately pulls it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
        yield* f.setup();
        yield* f.git(["commit", "--allow-empty", "-m", "main"]);
        const origin = `${f.root}/remote.git`;
        yield* f.git(["init", "--bare", "--initial-branch=main", origin]);
        yield* f.git(["config", `url.${origin}.insteadOf`, "https://github.com/acme/project.git"]);
        yield* f.git(["push"]);
        yield* f.git(["checkout", "-b", "new-feature", "origin/main"]);
        yield* f.git(["commit", "--allow-empty", "-m", "feature"]);
        yield* f.git(["push"]);
        assert.equal(
          yield* f.git(["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/new-feature",
        );
        const other = `${f.root}/other`;
        yield* f.git(["clone", "--branch=new-feature", origin, other]);
        yield* f.git(["-C", other, "config", "user.name", bot.name]);
        yield* f.git(["-C", other, "config", "user.email", bot.email]);
        yield* f.git(["-C", other, "config", "commit.gpgsign", "false"]);
        yield* f.git(["-C", other, "commit", "--allow-empty", "-m", "remote feature update"]);
        yield* f.git(["-C", other, "push"]);
        yield* f.git(["pull", "--ff-only"]);
        assert.equal(
          yield* f.git(["rev-parse", "HEAD"]),
          yield* f.git(["-C", other, "rev-parse", "HEAD"]),
        );
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect(
    "retains cached bot offline and clears it on confirmed replacement until the new bot resolves",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.setup();
          for (const metadata of [
            undefined,
            { status: "unknown" } as const,
            { status: "pending", appId: "12" } as const,
          ]) {
            yield* f.setup(metadata);
            assert.equal(yield* f.git(["config", "user.email"]), bot.email);
          }
          yield* f.setup({ status: "pending", appId: "13" });
          assert.equal(yield* f.git(["config", "user.name"]), "");
          assert.notEqual((yield* f.run(["commit", "--allow-empty", "-m", "not old bot"])).code, 0);
          for (const metadata of [undefined, { status: "unknown" } as const]) {
            yield* f.setup(metadata);
            assert.notEqual(
              (yield* f.run(["commit", "--allow-empty", "-m", "no stale bot during outage"])).code,
              0,
            );
          }
          const next = {
            ...bot,
            appId: "13",
            appSlug: "new-launchpad",
            name: "new-launchpad[bot]",
            email: "124+new-launchpad[bot]@users.noreply.github.com",
            botUserId: 124,
          };
          yield* f.setup(next);
          yield* f.git(["commit", "--allow-empty", "-m", "new bot"]);
          assert.equal(yield* f.git(["show", "-s", "--format=%ae"]), next.email);
          yield* f.setup({ status: "pending", appId: "13", appSlug: "renamed-launchpad" });
          assert.notEqual(
            (yield* f.run(["commit", "--allow-empty", "-m", "not stale name"])).code,
            0,
          );
          yield* f.setup(next);
          yield* f.setup({ status: "unconfigured" });
          assert.equal(yield* f.git(["config", "author.email"]), "");
          assert.notEqual((yield* f.run(["commit", "--allow-empty", "-m", "no app"])).code, 0);
        }),
      ).pipe(Effect.provide(environment)),
  );

  it.effect("never removes another Git lock and rejects changes before atomic publication", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture,
          config = yield* prepareThreadVmGitConfig(f.root, "github.com/acme/project", bot),
          original = yield* f.fs.readFileString(config.configPath);
        yield* f.fs.writeFileString(`${config.configPath}.lock`, "other command");
        assert.include(
          (yield* publishThreadVmGitConfig(config).pipe(Effect.flip)).message,
          "config.lock",
        );
        assert.equal(yield* f.fs.readFileString(`${config.configPath}.lock`), "other command");
        assert.equal(yield* f.fs.readFileString(config.configPath), original);
        yield* f.fs.remove(`${config.configPath}.lock`);
        yield* f.git(["config", "unrelated.change", "while-preparing"]);
        yield* publishThreadVmGitConfig(config).pipe(Effect.flip);
        assert.equal(yield* f.fs.exists(`${config.configPath}.lock`), false);
        assert.equal(yield* f.git(["config", "unrelated.change"]), "while-preparing");
        assert.notEqual((yield* f.run(["config", "user.name"])).code, 0);
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect("keeps repeated setup byte-stable and leaves detached HEAD untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.setup(),
          before = yield* f.fs.readFileString(first.configPath);
        yield* f.setup();
        assert.equal(yield* f.fs.readFileString(first.configPath), before);
        yield* f.git(["commit", "--allow-empty", "-m", "base"]);
        yield* f.git(["checkout", "--detach"]);
        const head = yield* f.git(["rev-parse", "HEAD"]);
        yield* f.setup();
        assert.equal(yield* f.git(["rev-parse", "HEAD"]), head);
        assert.equal(yield* f.git(["branch", "--show-current"]), "");
      }),
    ).pipe(Effect.provide(environment)),
  );
});
