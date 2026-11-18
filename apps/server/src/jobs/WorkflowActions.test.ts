import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { GitManager } from "../git/GitManager.ts";
import { SetupProcessAdapter } from "../terminal/SetupProcessAdapter.ts";
import { WorkflowReviewGitDirectory } from "../vcs/WorkflowReviewGitDirectory.ts";
import { VmCoordinatorProcess } from "../vmWorkloadCommand.ts";

import * as ServerConfig from "../config.ts";
import {
  CurrentWorkflowCommand,
  make as makeProcessRunner,
  ProcessRunner,
  ProcessSpawnError,
  type ProcessRunOutput,
} from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  make as makeActions,
  readWorkflowHead,
  readWorkflowTree,
  WorkflowActionError,
  type WorkflowActionIO,
} from "./WorkflowActions.ts";
import { baseCommit, commitAt, harness, id, initial } from "./WorkflowActions.test-fixture.ts";
import { type WorkflowRun, WorkflowRunStore } from "./WorkflowRunStore.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const realGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-actions-" }),
  ),
  Layer.provide(VcsProcess.layerLocal),
  Layer.provideMerge(NodeServices.layer),
);

const makeRealGit = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-actions-git-" });
  const git = (args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "WorkflowActions.test.git", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@example.test"]);
  yield* git(["config", "commit.gpgsign", "false"]);
  yield* git(["config", "push.gpgsign", "false"]);
  yield* git(["config", "core.hooksPath", ".git/hooks"]);
  yield* git(["commit", "--allow-empty", "-m", "base"]);
  return { cwd, fs, driver, git, base: yield* git(["rev-parse", "HEAD"]) };
});

it.effect("reads the original job HEAD without running checkout filters", () =>
  Effect.gen(function* () {
    const { base, cwd, fs, driver, git } = yield* makeRealGit();
    const branch = "t3-job/filter-test";
    yield* git(["checkout", "-b", branch]);
    yield* fs.writeFileString(`${cwd}/tracked.txt`, "before\n");
    yield* git(["add", "tracked.txt"]);
    yield* git(["commit", "-m", "add tracked file"]);
    const head = yield* git(["rev-parse", "HEAD"]);
    yield* git(["replace", head, base]);
    yield* git(["config", "filter.marker.clean", "touch filter-ran; cat"]);
    yield* fs.writeFileString(`${cwd}/.git/info/attributes`, "tracked.txt filter=marker\n");
    yield* fs.writeFileString(`${cwd}/tracked.txt`, "after!\n");

    assert.equal(yield* readWorkflowHead(driver, cwd, branch), head);
    assert.isFalse(yield* fs.exists(`${cwd}/filter-ran`));
    yield* git(["status", "--porcelain=2", "--branch"]);
    assert.isTrue(yield* fs.exists(`${cwd}/filter-ran`));
    assert.isNull(yield* readWorkflowHead(driver, cwd, "wrong-branch"));

    const linked = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-linked-" });
    yield* git(["worktree", "add", "-b", "t3-job/linked", linked, base]);
    assert.equal(yield* readWorkflowHead(driver, linked, "t3-job/linked"), base);

    yield* git(["symbolic-ref", "refs/heads/t3-job/alias", `refs/heads/${branch}`]);
    yield* git(["symbolic-ref", "HEAD", "refs/heads/t3-job/alias"]);
    assert.isNull(yield* readWorkflowHead(driver, cwd, "t3-job/alias"));
    yield* git(["update-ref", "--no-deref", "HEAD", head]);
    assert.isNull(yield* readWorkflowHead(driver, cwd, branch));
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("compares saved trees even when Git hides a changed submodule", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-review-tree-" });
    const git = (args: ReadonlyArray<string>) =>
      driver
        .execute({ operation: "WorkflowActions.test.git", cwd, args })
        .pipe(Effect.map((result) => result.stdout.trim()));
    yield* git(["init"]);
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@example.test"]);
    yield* git(["config", "commit.gpgsign", "false"]);
    yield* git(["config", "diff.ignoreSubmodules", "all"]);
    yield* git(["commit", "--allow-empty", "-m", "base"]);
    const base = yield* git(["rev-parse", "HEAD"]);
    yield* git(["update-index", "--add", "--cacheinfo", `160000,${base},dep`]);
    yield* git(["commit", "-m", "pin dependency"]);
    const saved = CheckpointRef.make("refs/t3/workflow-test/saved");
    const current = CheckpointRef.make("refs/t3/workflow-test/current");
    const savedCommit = yield* git(["rev-parse", "HEAD"]);
    yield* git(["update-ref", saved, savedCommit]);
    yield* git(["commit", "--allow-empty", "-m", "same contents"]);
    const equalTreeCommit = yield* git(["rev-parse", "HEAD"]);
    yield* git(["update-ref", current, equalTreeCommit]);
    const savedTree = yield* readWorkflowTree(driver, cwd, saved);
    assert.notEqual(equalTreeCommit, savedCommit);
    assert.equal(yield* readWorkflowTree(driver, cwd, current), savedTree);

    yield* git(["update-index", "--cacheinfo", `160000,${savedCommit},dep`]);
    yield* git(["commit", "-m", "change dependency"]);
    yield* git(["update-ref", current, "HEAD"]);
    assert.equal(yield* git(["diff", saved, current]), "");
    assert.notEqual(yield* readWorkflowTree(driver, cwd, current), savedTree);
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-actions-" }),
        ),
        Layer.provide(VcsProcess.layerLocal),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("requires original ancestry and pushes the job branch without tags", () =>
  Effect.gen(function* () {
    const { cwd, fs, driver, git, base } = yield* makeRealGit();
    yield* git(["commit", "--allow-empty", "-m", "published"]);
    const published = yield* git(["rev-parse", "HEAD"]);
    const tree = yield* git(["rev-parse", "HEAD^{tree}"]);
    const divergent = yield* git(["commit-tree", tree, "-p", base, "-m", "divergent"]);
    const descendant = yield* git(["commit-tree", tree, "-p", published, "-m", "descendant"]);
    const bare = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-actions-remote-" });
    const ref = "refs/heads/t3-job/job";
    yield* git(["init", "--bare", bare]);
    yield* git(["push", bare, `${published}:${ref}`]);
    yield* git(["config", "push.followTags", "true"]);
    yield* git(["tag", "--no-sign", "-a", "workflow-extra-tag", descendant, "-m", "fixture"]);

    const publishRework = Effect.fnUntraced(function* (candidate: string) {
      let useBare = false;
      const h = yield* harness("none", undefined, (input) => {
        if (!useBare) return;
        if (input.args.includes("merge-base")) {
          return driver.execute({
            ...input,
            cwd,
            args: [...input.args.slice(0, -2), published, candidate],
          });
        }
        if (input.args[0] === "ls-remote") {
          return driver
            .execute({ operation: input.operation, cwd, args: ["ls-remote", "--refs", bare, ref] })
            .pipe(
              Effect.map((result) => ({
                ...result,
                stdout: result.stdout
                  .replace(published, commitAt(1))
                  .replace(candidate, commitAt(2)),
              })),
            );
        }
        if (input.args[0] === "push") {
          return driver
            .execute({
              operation: input.operation,
              cwd,
              args: input.args.map((arg) =>
                arg === "https://github.com/acme/repo.git"
                  ? bare
                  : arg
                      .replace(`${ref}:${commitAt(1)}`, `${ref}:${published}`)
                      .replace(`${commitAt(2)}:`, `${candidate}:`),
              ),
            })
            .pipe(Effect.provideService(CurrentWorkflowCommand, null));
        }
      });
      yield* h.actions.execute(id, h.io);
      yield* h.beginRework();
      useBare = true;
      return yield* h.actions.execute("push:1", h.io).pipe(Effect.result);
    });

    for (const fault of ["replace", "graft"] as const) {
      const graftPath = `${cwd}/.git/info/grafts`;
      if (fault === "replace") yield* git(["replace", divergent, descendant]);
      else yield* fs.writeFileString(graftPath, `${divergent} ${published}\n`);
      yield* git(["merge-base", "--is-ancestor", published, divergent]);
      const result = yield* publishRework(divergent);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.match(result.failure.message, /cannot be fast-forwarded/);
      assert.equal(yield* git(["--git-dir", bare, "rev-parse", ref]), published);
      if (fault === "replace") yield* git(["replace", "-d", divergent]);
      else yield* fs.remove(graftPath);
    }

    assert.equal((yield* publishRework(descendant))._tag, "Success");
    assert.equal(yield* git(["--git-dir", bare, "rev-parse", ref]), descendant);
    assert.equal(yield* git(["--git-dir", bare, "tag", "--list"]), "");
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("blocks workflow Push to a different effective push URL", () =>
  Effect.gen(function* () {
    const { cwd, driver, git } = yield* makeRealGit();
    yield* git(["remote", "add", "upstream", "https://github.com/acme/repo.git"]);
    yield* git(["remote", "set-url", "--push", "upstream", "https://github.com/acme/other.git"]);
    const h = yield* harness("none", undefined, (input) =>
      input.operation === "WorkflowActions.verifyRemote"
        ? driver
            .execute({ ...input, cwd })
            .pipe(Effect.provideService(CurrentWorkflowCommand, null))
        : undefined,
    );
    const failure = yield* Effect.flip(h.actions.execute(id, h.io));
    assert.match(failure.message, /remote no longer resolves/);
    assert.equal(h.counts().pushes, 0);
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("reports a required Git LFS upload before attempting workflow Push", () =>
  Effect.gen(function* () {
    const { base, cwd, driver, fs, git } = yield* makeRealGit();
    yield* fs.writeFileString(
      `${cwd}/asset.bin`,
      `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 123\n`,
    );
    yield* git(["add", "asset.bin"]);
    yield* git(["commit", "-m", "Add an LFS pointer"]);
    const commit = yield* git(["rev-parse", "HEAD"]);
    const h = yield* harness("none", undefined, (input) =>
      input.operation === "WorkflowActions.checkLfs"
        ? driver.execute({
            ...input,
            cwd,
            args: input.args.map((arg) =>
              arg.replace(commitAt(1), commit).replace(baseCommit, base),
            ),
          })
        : undefined,
    );
    const failure = yield* Effect.flip(h.actions.execute(id, h.io));
    assert.match(failure.message, /requires a Git LFS upload/);
    assert.equal(h.counts().pushes, 0);
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("refuses a lost commit reply when a graft supplies the expected parent", () =>
  Effect.gen(function* () {
    const { cwd, fs, driver, git, base } = yield* makeRealGit();
    const tree = yield* git(["rev-parse", "HEAD^{tree}"]);
    const unrelated = yield* git(["commit-tree", tree, "-m", "unrelated"]);
    yield* fs.writeFileString(`${cwd}/.git/info/grafts`, `${unrelated} ${base}\n`);
    assert.equal(
      yield* git(["--no-replace-objects", "show", "-s", "--format=%P", unrelated]),
      base,
    );

    const h = yield* harness("commit-reply", undefined, (input) =>
      input.args.includes("--format=%P")
        ? driver.execute({ ...input, cwd, args: [...input.args.slice(0, -1), unrelated] }).pipe(
            Effect.map((result) => ({
              ...result,
              stdout: result.stdout.replace(base, baseCommit),
            })),
          )
        : undefined,
    );
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    const result = yield* Effect.flip(h.actions.execute(id, h.io));
    assert.match(result.message, /changed outside this action/);
    assert.deepEqual(h.counts(), { commits: 1, pushes: 0 });
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("refuses a successful commit whose hook moves HEAD to unrelated history", () =>
  Effect.gen(function* () {
    const { cwd, fs, driver, git } = yield* makeRealGit();
    const tree = yield* git(["rev-parse", "HEAD^{tree}"]);
    const unrelated = yield* git(["commit-tree", tree, "-m", "unrelated"]);
    const hook = `${cwd}/.git/hooks/post-commit`;
    yield* fs.writeFileString(hook, `#!/bin/sh\ngit update-ref HEAD ${unrelated}\n`);
    yield* fs.chmod(hook, 0o755);
    yield* git(["commit", "--allow-empty", "-m", "workflow"]);
    assert.equal(yield* git(["rev-parse", "HEAD"]), unrelated);
    assert.equal(yield* git(["rev-parse", "HEAD^{tree}"]), tree);

    const h = yield* harness("none", undefined, (input) =>
      input.args.includes("--format=%P")
        ? driver.execute({ ...input, cwd, args: [...input.args.slice(0, -1), "HEAD"] })
        : undefined,
    );
    const result = yield* Effect.flip(h.actions.execute(id, h.io));
    assert.match(result.message, /Commit hooks changed the prepared commit's parent/);
    assert.deepEqual(h.counts(), { commits: 1, pushes: 0 });
    assert.isNull((yield* h.io.read).actions![0]!.commitSha);
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("checks the committed parent without running the checkout's signature verifier", () =>
  Effect.gen(function* () {
    const { cwd, fs, driver, git, base } = yield* makeRealGit();
    const tree = yield* git(["rev-parse", "HEAD^{tree}"]);
    const verifier = `${cwd}/.git/verifier`;
    const marker = `${cwd}/.git/verifier-ran`;
    yield* fs.writeFileString(verifier, "#!/bin/sh\ntouch .git/verifier-ran\nexit 1\n");
    yield* fs.chmod(verifier, 0o755);
    yield* git(["config", "log.showSignature", "true"]);
    yield* git(["config", "gpg.format", "openpgp"]);
    yield* git(["config", "gpg.program", verifier]);
    const signed = (yield* driver.execute({
      operation: "WorkflowActions.test.signedCommit",
      cwd,
      args: ["hash-object", "-t", "commit", "-w", "--stdin"],
      stdin: [
        `tree ${tree}`,
        `parent ${base}`,
        "author Test <test@example.test> 1 +0000",
        "committer Test <test@example.test> 1 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " fixture-signature",
        " -----END PGP SIGNATURE-----",
        "",
        "Implement",
        "",
      ].join("\n"),
    })).stdout.trim();
    yield* git(["show", "-s", "--format=%P", signed]);
    assert.isTrue(yield* fs.exists(marker));
    yield* fs.remove(marker);

    const h = yield* harness("none", undefined, (input) =>
      input.args.includes("--format=%P")
        ? driver.execute({ ...input, cwd, args: [...input.args.slice(0, -1), signed] }).pipe(
            Effect.map((result) => ({
              ...result,
              stdout: result.stdout.replace(base, baseCommit),
            })),
          )
        : undefined,
    );
    yield* h.actions.execute(id, h.io);
    assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
    assert.isFalse(yield* fs.exists(marker));
  }).pipe(Effect.provide(realGitLayer)),
);

it.effect("verifies the captured tree even if the temporary verification ref moves", () =>
  Effect.gen(function* () {
    const h = yield* harness("none", undefined, (input) =>
      input.args.at(-1)?.startsWith("refs/t3/workflow-publishing/")
        ? Effect.die("The temporary ref now points at an unrelated commit")
        : undefined,
    );
    yield* h.actions.execute(id, h.io);
    assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("resumes VM publishing only with a matching saved checkpoint object", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowRunStore;
    for (const mode of [
      "legacy",
      "no-pin",
      "different-tree",
      "missing-object",
      "no-rules",
      "ready",
    ] as const) {
      let protectedCalls = 0;
      const h = yield* harness(
        "none",
        undefined,
        (input) =>
          mode === "missing-object" && input.args.at(-1) === "saved-commit^{tree}"
            ? Effect.fail(
                new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  exitCode: 128,
                  detail: "Missing checkpoint object",
                }),
              )
            : undefined,
        undefined,
        true,
      ).pipe(
        Effect.provideService(ProcessRunner, {
          run: () =>
            Effect.flatMap(
              Effect.sync(() => {
                protectedCalls++;
              }),
              () =>
                Effect.fail(
                  new ProcessSpawnError({
                    command: "git",
                    argumentCount: 0,
                    cause: "Protected worker offline",
                  }),
                ),
            ),
        }),
        Effect.provideService(WorkflowRunStore, {
          ...store,
          isVmFenceActive: () => Effect.succeed(true),
          getWorkflowIgnoreRules: () =>
            Effect.succeed(mode === "no-rules" ? null : new Uint8Array()),
          getCheckpointPinForRun: (binding, turnId, checkpointRef) =>
            Effect.succeed(
              binding.jobId === "job" &&
                binding.generation === 1 &&
                turnId === "turn" &&
                checkpointRef === "refs/review" &&
                mode !== "no-pin"
                ? {
                    checkpointRef,
                    commitId: "saved-commit",
                    treeId: mode === "different-tree" ? "different" : "prepared",
                    baselineCommitId: "base",
                  }
                : null,
            ),
        }),
      );
      yield* h.io.update((run) => ({
        ...run,
        runtime: {
          ...run.runtime,
          kind: "vm",
          jobId: run.jobId,
          threadId: run.progress.threadId,
          organizationId: run.workflow.organizationId,
          repositoryId: run.workflow.repositoryId,
          allocationId: "vm",
          operationId: "operation",
          generation: 1,
        },
        actions: run.actions!.map((action) => ({
          ...action,
          ...(mode === "legacy" ? {} : { checkpointTurnId: "turn" }),
        })),
      }));
      const io: WorkflowActionIO = {
        ...h.io,
        vmPublishing: {
          credential: () =>
            Effect.succeed({
              token: Redacted.make("synthetic-read"),
              bot: { name: "App", email: "app@example.test" },
            }),
          retain: () => Effect.die("unused"),
          recoverCommit: () => Effect.die("unused"),
          arm: () => Effect.die("unused"),
          stop: () => Effect.die("unused"),
          settle: () => Effect.die("unused"),
        },
      };
      const result = yield* Effect.flip(
        h.actions
          .execute(id, io)
          .pipe(Effect.provideService(WorkflowReviewGitDirectory, "/protected")),
      );
      const expected =
        mode === "ready"
          ? /Failed to spawn process/
          : mode === "no-rules"
            ? /saved workflow Git ignore rules are unavailable/
            : /saved workflow VM result is unavailable/;
      assert.match(result.message, expected);
      assert.equal(protectedCalls, mode === "ready" ? 1 : 0);
      assert.deepEqual(h.counts(), { commits: 0, pushes: 0 });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "publishes a new Machine run to its Launchpad branch and observes completion on replay",
  () =>
    Effect.gen(function* () {
      const h = yield* harness("none", undefined, undefined, "launchpad");
      yield* h.actions.execute(id, h.io);
      yield* h.actions.execute(id, h.io);
      assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
      const run = yield* h.io.read;
      assert.equal(run.actions![0]!.state, "completed");
      assert.equal(run.preparedHead, commitAt(1));
      assert.isTrue(run.actions![0]!.commands.every((command) => command.stopped));
    }).pipe(Effect.provide(NodeServices.layer)),
);
for (const fault of ["commit-reply", "push-reply"] as const)
  it.effect(`reconciles ${fault} without repeating the effect`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
      yield* h.actions.execute(id, h.io);
      assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
it.effect("does not publish changes introduced by a commit hook", () =>
  Effect.gen(function* () {
    const h = yield* harness("hook");
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    assert.equal(h.counts().pushes, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("does not push a commit whose original tree differs from its replacement", () =>
  Effect.gen(function* () {
    const h = yield* harness("hook-replace");
    const result = yield* Effect.flip(h.actions.execute(id, h.io));
    assert.match(result.message, /Commit hooks changed the saved result/);
    assert.deepEqual(h.counts(), { commits: 1, pushes: 0 });
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("does not open a PR after the workspace diverges from the saved tree", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.actions.execute(id, h.io);
    yield* h.beginPr();
    h.changeWorkspaceTree("changed-after-review");
    const result = yield* Effect.flip(h.actions.execute("pr:0", h.io));
    assert.match(result.message, /Prepared files changed after the saved result/);
    assert.equal(h.prCounts().creates, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("blocks unconfirmed ownership until recovery proves stopping", () =>
  Effect.gen(function* () {
    const h = yield* harness("ownership");
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    assert.isFalse(yield* h.actions.recover(h.io));
    assert.isFalse((yield* h.io.read).actions![0]!.commands[0]!.stopped);
    h.recoverAfterBoot();
    assert.isTrue(yield* h.actions.recover(h.io));
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("retries a lost VM stop acknowledgement without stopping the command again", () =>
  Effect.gen(function* () {
    const h = yield* harness("ownership");
    const commandId = "remote-push";
    yield* h.io.update((run) => ({
      ...run,
      runtime: {
        ...run.runtime,
        kind: "vm",
        jobId: run.jobId,
        threadId: run.progress.threadId,
        organizationId: run.workflow.organizationId,
        repositoryId: run.workflow.repositoryId,
        allocationId: "vm",
        operationId: "operation",
        generation: 1,
      },
      actions: [
        {
          ...run.actions![0]!,
          state: "uncertain",
          phase: "push",
          commands: [
            {
              id: commandId,
              phase: "push",
              pid: 42,
              identity: "birth",
              boot: null,
              stopped: true,
              code: 0,
            },
          ],
        },
      ],
    }));
    let deliveries = 0;
    const io: WorkflowActionIO = {
      ...h.io,
      vmPublishing: {
        credential: () => Effect.die("unused"),
        retain: () => Effect.die("unused"),
        recoverCommit: () => Effect.die("unused"),
        arm: () => Effect.die("unused"),
        stop: (action, command) =>
          Effect.suspend(() => {
            assert.deepEqual([action, command], [id, commandId]);
            return ++deliveries === 1
              ? Effect.fail(new WorkflowActionError({ message: "Stop acknowledgement lost" }))
              : Effect.void;
          }),
        settle: () => Effect.die("unused"),
      },
    };
    const readStop = io.read.pipe(Effect.map((run) => run.actions![0]!.commands[0]!));

    assert.match((yield* Effect.flip(h.actions.recover(io))).message, /acknowledgement lost/);
    const stopped = yield* readStop;
    assert.isTrue(stopped.stopped);
    assert.isUndefined(stopped.relayStopAcknowledged);
    assert.isTrue(yield* h.actions.recover(io));
    assert.isTrue((yield* readStop).relayStopAcknowledged);
    assert.isTrue(yield* h.actions.recover(io));
    assert.equal(deliveries, 2);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("does not begin Push when Cancel arrives during commit", () =>
  Effect.gen(function* () {
    const h = yield* harness("cancel");
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    assert.equal(h.counts().pushes, 0);
    assert.equal((yield* h.io.read).progress.status, "cancelling");
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const fault of ["none", "pr-reply", "pr-save"] as const)
  it.effect(`recovers PR ${fault} and reuses the same PR across generations`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      yield* h.actions.execute(id, h.io);
      yield* h.beginPr();
      const first = yield* h.actions.execute("pr:0", h.io).pipe(Effect.result);
      assert.equal(first._tag, fault === "none" ? "Success" : "Failure");
      yield* h.actions.execute("pr:0", h.io);
      h.editBody();
      yield* h.beginPr(1);
      yield* h.actions.execute("pr:1", h.io);
      assert.equal(h.prCounts().creates, 1);
      assert.isAbove(h.prCounts().knownRead, 0);
      assert.equal(
        (yield* h.io.read).publication?.pullRequestUrl,
        "https://github.com/acme/repo/pull/17",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
for (const fault of [
  "pr-invisible",
  "pr-marker",
  "pr-closed",
  "pr-truncated",
  "pr-foreign",
] as const)
  it.effect(`never repeats creation after ${fault}`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      yield* h.actions.execute(id, h.io);
      yield* h.beginPr();
      assert.equal((yield* h.actions.execute("pr:0", h.io).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* h.actions.execute("pr:0", h.io).pipe(Effect.result))._tag, "Failure");
      assert.equal(h.prCounts().creates, 1);
      assert.equal(
        (yield* h.io.read).publication?.pullRequestUrl,
        fault === "pr-closed" ? "https://github.com/acme/repo/pull/17" : null,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

for (const fault of ["ownership-no-boot", "ownership-other-host"] as const)
  it.effect(`does not accept reboot recovery with ${fault}`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
      h.recoverAfterBoot();
      assert.isFalse(yield* h.actions.recover(h.io));
      assert.isFalse((yield* h.io.read).actions![0]!.commands[0]!.stopped);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
it.effect("publishes revised rework to the same branch and preserves the job PR binding", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.actions.execute(id, h.io);
    yield* h.beginPr();
    yield* h.actions.execute("pr:0", h.io);
    yield* h.beginRework();
    yield* h.actions.execute("push:1", h.io);
    yield* h.beginPr(1);
    yield* h.actions.execute("pr:1", h.io);
    const run = yield* h.io.read;
    assert.equal(run.publication?.publishedHead, commitAt(2));
    assert.equal(run.publication?.pullRequestUrl, "https://github.com/acme/repo/pull/17");
    assert.deepEqual(h.counts(), { commits: 2, pushes: 2 });
    assert.equal(h.prCounts().creates, 1);
    assert.equal(run.actions?.length, 4);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses embedded remote credentials before creating command intent", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.io.update((run) => ({
      ...run,
      publication: { ...run.publication!, remoteUrl: "https://token@github.com/acme/repo.git" },
    }));
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(h.counts(), { commits: 0, pushes: 0 });
    assert.equal((yield* h.io.read).actions![0]!.commands.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const fault of ["commit-reply", "push-reply", "pr-reply"] as const)
  it.effect(`requested Pause preserves phase reconciliation after ${fault}`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      let actionId = id;
      if (fault === "pr-reply") {
        yield* h.actions.execute(id, h.io);
        yield* h.beginPr();
        actionId = "pr:0";
      }
      assert.equal((yield* h.actions.execute(actionId, h.io).pipe(Effect.result))._tag, "Failure");
      yield* h.io.update((run) => ({
        ...run,
        manualPause: { state: "requested", promptId: "reserved-action" },
      }));
      const before = (yield* h.io.read).actions!.find((action) => action.actionId === actionId)!;
      yield* h.actions.execute(actionId, h.io);
      const run = yield* h.io.read;
      const completed = run.actions!.find((action) => action.actionId === actionId)!;
      assert.equal(completed.state, "completed");
      assert.equal(completed.generation, before.generation);
      assert.equal(completed.prBody, before.prBody);
      assert.equal(completed.commitMessage, before.commitMessage);
      assert.equal(run.manualPause?.state, "requested");
      assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
      assert.equal(h.prCounts().creates, fault === "pr-reply" ? 1 : 0);
      assert.isTrue(
        run.actions!.every((action) => action.commands.every((command) => command.stopped)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

it.effect(
  "recovers a lost VM Push with real Git and checks the PR SHA without creating it twice",
  () =>
    Effect.gen(function* () {
      const { base, cwd, fs, driver, git } = yield* makeRealGit();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-vm-publish-" });
      const protectedDir = `${root}/review.git`;
      const restoredDir = `${root}/restored.git`;
      const repeatedPushDir = `${root}/repeat-restored.git`;
      const process = yield* makeProcessRunner();
      const branch = "launchpad/job";
      const ref = `refs/heads/${branch}`;
      const checkedGit = (workdir: string, args: ReadonlyArray<string>) =>
        process.run({ cwd: workdir, command: "git", args }).pipe(
          Effect.map((output) => {
            assert.equal(output.code, 0, output.stderr);
            return output.stdout.trim();
          }),
        );
      yield* git(["checkout", "-b", branch]);
      yield* checkedGit(root, ["clone", "--bare", cwd, protectedDir]);
      yield* fs.writeFileString(`${cwd}/history-only.txt`, "synthetic intermediate data\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "agent intermediate commit"]);
      const agentHead = yield* git(["rev-parse", "HEAD"]);
      yield* fs.remove(`${cwd}/history-only.txt`);
      yield* fs.writeFileString(`${cwd}/result.txt`, "saved result\n");
      yield* git(["add", "."]);
      const tree = yield* git(["write-tree"]);
      const checkpoint = yield* git(["commit-tree", tree, "-p", base, "-m", "private checkpoint"]);
      yield* git(["update-ref", "refs/t3/checkpoint", checkpoint]);
      yield* checkedGit(protectedDir, ["fetch", cwd, "refs/t3/checkpoint:refs/t3/checkpoint"]);
      yield* checkedGit(root, ["clone", "--bare", protectedDir, restoredDir]);
      yield* checkedGit(restoredDir, [
        "fetch",
        protectedDir,
        "refs/t3/checkpoint:refs/t3/checkpoint",
      ]);
      yield* checkedGit(root, ["clone", "--bare", restoredDir, repeatedPushDir]);
      const hook = `${cwd}/.git/hooks/pre-commit`;
      yield* fs.writeFileString(
        hook,
        '#!/bin/sh\ntest -z "${GIT_CONFIG_VALUE_0:-}${GH_TOKEN:-}" || exit 73\nprintf called >> .git/hook-calls\n',
      );
      yield* fs.chmod(hook, 0o755);

      const original = initial();
      const vmRuntime = {
        ...original.runtime,
        kind: "vm" as const,
        jobId: original.jobId,
        threadId: original.progress.threadId,
        organizationId: original.workflow.organizationId,
        repositoryId: original.workflow.repositoryId,
        allocationId: "allocation",
        operationId: "operation",
        generation: 1,
      };
      let state: WorkflowRun = {
        ...original,
        runtime: vmRuntime,
        baseSha: base,
        jobBranchPrefix: "launchpad",
        worktreePath: cwd,
        preparedHead: agentHead,
        userId: null,
        origin: {
          kind: "automation",
          organizationId: original.workflow.organizationId,
          repositoryId: original.workflow.repositoryId,
          workflowId: original.workflow.workflowId,
          occurrenceId: "linear-event",
          source: {
            provider: "linear",
            applicationId: "linear-app",
            workspaceId: "workspace",
            connectionId: "linear",
            grantId: "repository-grant",
          },
        },
        actions: [{ ...original.actions![0]!, parent: agentHead, tree, checkpointTurnId: "turn" }],
      };
      let remote: string | null = null;
      let retained: { readonly sha: string; readonly object: Uint8Array } | null = null;
      let pullCreated = false;
      let prHead!: string;
      let pushCount = 0;
      let prCount = 0;
      let prAttempts = 0;
      let prTokens = 0;
      const rejected = new Set<string>();
      const recoveredActions: string[] = [];
      const events: string[] = [];
      const prUrl = "https://github.com/acme/repo/pull/1";
      const bot = { name: "app[bot]", email: "123+app[bot]@users.noreply.github.com" };
      const io: WorkflowActionIO = {
        read: Effect.sync(() => state),
        update: (change) => Effect.sync(() => (state = change(state))),
        vmPublishing: {
          credential: (_, scope) =>
            Effect.sync(() => ({
              bot,
              token: Redacted.make(
                scope === "open_pull_request"
                  ? `synthetic-${scope}-${++prTokens}`
                  : `synthetic-${scope}`,
              ),
            })),
          canCreatePull: (actionId) =>
            Effect.sync(
              () =>
                state.actions
                  ?.find((action) => action.actionId === actionId)
                  ?.commands.every((command) => command.pid === null || rejected.has(command.id)) ??
                false,
            ),
          rejectPullAuthorization: (actionId, commandId) =>
            Effect.sync(() => {
              const command = state.actions
                ?.find((action) => action.actionId === actionId)
                ?.commands.find((command) => command.id === commandId);
              assert.isTrue(command?.stopped);
              assert.equal(command?.code, 0);
              rejected.add(commandId);
              events.push("rejected-credential");
            }),
          recordPull: (_, url) =>
            Effect.sync(() => {
              assert.equal(url, prUrl);
              events.push("record-pr");
            }),
          retain: (_, commit) =>
            Effect.sync(() => {
              events.push("retain");
              retained = commit;
            }),
          recoverCommit: (actionId, sha) =>
            Effect.sync(() => {
              recoveredActions.push(actionId);
              return retained?.sha === sha ? retained.object : null;
            }),
          arm: (_, command) =>
            Effect.sync(() => {
              assert.equal(command.pid, 84);
              assert.equal(command.identity, "native-identity");
              events.push("arm");
            }),
          stop: () =>
            Effect.sync(() => {
              events.push("stop");
            }),
          settle: (_, result) =>
            Effect.sync(() => {
              assert.equal(result.commitSha, remote);
              events.push(result.pullRequestUrl ? "settle-pr" : "settle-push");
            }),
        },
      };
      const result = (stdout: string): ProcessRunOutput => ({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
      const network: ProcessRunner["Service"] = {
        run: (input) =>
          Effect.gen(function* () {
            assert.isTrue(yield* VmCoordinatorProcess);
            if (input.args.includes("ls-remote"))
              return result(remote ? `${remote}\t${ref}\n` : "");
            const isPush = input.args.includes("push");
            if (isPush || input.command === "/usr/bin/curl") {
              assert.isFalse(input.args.join(" ").includes("synthetic-"));
              const isPost = input.args.includes("POST");
              if (isPush || isPost) {
                assert.exists(input.owner);
                yield* input.owner!.capture(84);
                yield* input.owner!.arm;
              }
              if (isPush) {
                assert.ok(retained);
                assert.include(input.args, `--force-with-lease=${ref}:`);
                assert.equal(input.args.at(-1), `${retained.sha}:${ref}`);
                assert.equal(input.cwd, protectedDir);
                events.push("remote-push");
                pushCount++;
                remote = retained.sha;
                yield* input.owner!.completed(0);
                yield* input.owner!.stop;
                return yield* new ProcessSpawnError({
                  command: "git",
                  argumentCount: 0,
                  cause: "Lost response",
                });
              }
              const receipt = {
                number: 1,
                html_url: prUrl,
                state: "open",
                merged_at: null,
                body: "<!-- launchpad-workflow-job:job -->",
                base: { ref: "main", repo: { full_name: "acme/repo" } },
                head: { ref: branch, sha: prHead, repo: { full_name: "acme/repo" } },
              };
              if (isPost) {
                prAttempts++;
                assert.include(input.stdin ?? "", `synthetic-open_pull_request-${prAttempts}`);
                yield* input.owner!.completed(0);
                yield* input.owner!.stop;
                if (prAttempts === 1) return result("{}\n401");
                assert.equal(rejected.size, 1);
                prCount++;
                pullCreated = true;
                return result(`${encodeJson(receipt)}\n201`);
              }
              const list = input.args.at(-1)?.includes("?");
              return result(`${encodeJson(list ? (pullCreated ? [receipt] : []) : receipt)}\n200`);
            }
            return yield* process.run(input);
          }),
      };
      const store = yield* WorkflowRunStore;
      const owner = {
        commandLauncher: Effect.succeed("native-coordinator"),
        host: Effect.succeed(null),
        inspect: () =>
          Effect.succeed({
            protocol: 4 as const,
            identity: "native-identity",
            owned: true,
            fullStop: false,
            boot: null,
          }),
        arm: () => Effect.succeed("git"),
        stop: () => Effect.void,
      };
      const actions = yield* makeActions.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(GitVcsDriver.GitVcsDriver, driver),
            Layer.succeed(ProcessRunner, network),
            Layer.succeed(WorkflowRunStore, {
              ...store,
              isVmFenceActive: () => Effect.succeed(true),
              getWorkflowIgnoreRules: () => Effect.succeed(new Uint8Array()),
              getCheckpointPinForRun: () =>
                Effect.succeed({
                  checkpointRef: "refs/review",
                  commitId: checkpoint,
                  treeId: tree,
                  baselineCommitId: base,
                }),
            }),
            Layer.mock(RepositoryAccess)({
              withFence: (effect) => effect,
              requireWorkflowProject: () => Effect.die("VM publishing must use its runtime fence"),
            }),
            Layer.mock(SetupProcessAdapter)({ ...owner, vmPublishing: owner }),
            Layer.mock(CheckpointStore)({
              captureCheckpoint: () => Effect.succeed({ commitId: checkpoint, treeId: tree }),
              resolvePinnedTree: () => Effect.succeed(tree),
              deleteCheckpointRefs: () => Effect.void,
            }),
            Layer.mock(GitManager)({
              prepareWorkflowCommit: () => Effect.succeed({ subject: "Save result", body: "" }),
              prepareWorkflowPullRequest: () =>
                Effect.succeed({ title: "Save result", body: "Details" }),
            }),
          ),
        ),
      );
      const execute = (actionId: string, directory = protectedDir) =>
        actions
          .execute(actionId, io)
          .pipe(Effect.provideService(WorkflowReviewGitDirectory, directory));
      yield* Effect.flip(execute(id));
      const published = retained!.sha;
      assert.equal(remote, published);
      assert.deepEqual(events.slice(0, 4), ["retain", "arm", "remote-push", "stop"]);
      assert.equal(yield* fs.readFileString(`${cwd}/.git/hook-calls`), "called");
      // Restore the checkout from before the hook and use a protected repository whose object store lacks the Push commit.
      yield* git(["update-ref", ref, agentHead]);
      yield* execute(id, restoredDir);
      assert.equal(pushCount, 1);
      assert.deepEqual(recoveredActions, [id]);
      assert.equal(yield* git(["rev-parse", "HEAD"]), published);
      assert.equal(yield* git(["show", "-s", "--format=%P", "HEAD"]), base);
      assert.equal(yield* fs.readFileString(`${cwd}/.git/hook-calls`), "called");
      assert.equal(state.actions![0]!.state, "completed");
      assert.include(events, "settle-push");

      state = {
        ...state,
        actions: [
          ...state.actions!,
          {
            ...state.actions![0]!,
            actionId: "pr",
            stepId: "pr",
            operation: "open_pull_request",
            state: "running",
            phase: "prepare",
            parent: published,
            commitSha: null,
            commands: [],
          },
        ],
      };
      prHead = "3".repeat(40);
      const mismatch = yield* Effect.flip(execute("pr", restoredDir));
      assert.match(mismatch.message, /pull request head changed/i);
      assert.equal(state.publication!.pullRequestUrl, prUrl);
      assert.notEqual(state.actions![1]!.state, "completed");
      prHead = published;
      yield* execute("pr", restoredDir);
      assert.equal(prCount, 1);
      assert.equal(prAttempts, 2);
      assert.equal(prTokens, 2);
      assert.include(events, "rejected-credential");
      assert.include(events, "record-pr");
      assert.equal(state.actions![1]!.state, "completed");
      assert.include(events, "settle-pr");

      const beginNoopPush = (actionId: string, parent: string, checkpointTurnId: string) => {
        state = {
          ...state,
          actions: [
            ...state.actions!,
            {
              ...state.actions![0]!,
              actionId,
              checkpointTurnId,
              parent,
              oldRemoteSha: published,
              state: "running",
              phase: "prepare",
              commitSha: null,
              commands: [],
            },
          ],
        };
      };

      // The next Push of the same result restores the disk from before the first Push.
      yield* git(["update-ref", ref, agentHead]);
      beginNoopPush("repeat-push", published, "turn");
      yield* execute("repeat-push", repeatedPushDir);
      assert.deepEqual(recoveredActions, [id, id]);
      assert.equal(pushCount, 1);
      assert.equal(yield* git(["rev-parse", "HEAD"]), published);
      assert.equal(yield* fs.readFileString(`${cwd}/result.txt`), "saved result\n");
      assert.equal(yield* fs.readFileString(`${cwd}/.git/hook-calls`), "called");
      assert.equal(state.actions!.at(-1)?.state, "completed");

      // A new Agent can yield the same tree with a different checkpoint and local commit.
      // It must use its own local parent, even when the previous Push committed that tree.
      const nextAgentHead = yield* git(["commit-tree", tree, "-p", published, "-m", "new Agent"]);
      yield* git(["update-ref", ref, nextAgentHead]);
      beginNoopPush("next-agent-push", nextAgentHead, "new-turn");
      yield* execute("next-agent-push", restoredDir);
      assert.deepEqual(recoveredActions, [id, id]);
      assert.equal(pushCount, 1);
      assert.equal(yield* git(["rev-parse", "HEAD"]), published);
      assert.equal(yield* fs.readFileString(`${cwd}/result.txt`), "saved result\n");
      assert.equal(state.actions!.at(-1)?.state, "completed");
    }).pipe(Effect.provide(realGitLayer)),
);
