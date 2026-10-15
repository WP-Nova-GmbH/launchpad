import { GitCommandError, SourceControlProviderError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { SetupProcessAdapter, SetupProcessError } from "../terminal/SetupProcessAdapter.ts";
import { CurrentWorkflowCommand } from "../processRunner.ts";
import { WorkflowRun } from "./WorkflowRunStore.ts";
import { make, WorkflowActionError, type WorkflowActionIO } from "./WorkflowActions.ts";

const id = "workflow:job:action:push:0";
const decodeRun = Schema.decodeUnknownSync(WorkflowRun);
function initial() {
  const checkpoint = {
    checkpointId: "checkpoint",
    turnId: "turn",
    checkpointRef: "refs/review",
    checkpointTurnCount: 1,
  };
  return decodeRun({
    jobId: "job",
    userId: "user",
    repositoryCanonicalKey: "github.com/acme/repo",
    instruction: "Implement",
    createdAt: "2026-10-15T00:00:00Z",
    workflow: {
      workflowId: "workflow",
      organizationId: "org",
      repositoryId: "repo",
      revision: 1,
      archived: false,
      createdAt: "now",
      updatedAt: "now",
      definition: {
        name: "Ship",
        environmentId: "env",
        projectId: "project",
        steps: [
          {
            id: "agent",
            kind: "agent",
            title: "Agent",
            instruction: "Implement",
            modelSelection: null,
          },
          { id: "push", kind: "action", title: "Push branch", action: "push" },
        ],
      },
    },
    modelSelection: { instanceId: "codex", model: "test" },
    baseBranch: "main",
    baseSha: "base",
    promptDispatched: true,
    executionReserved: true,
    worktreePath: "/job",
    preparedHead: "base",
    approvedBy: null,
    publication: {
      remoteName: "upstream",
      remoteUrl: "https://github.com/acme/repo.git",
      publishedHead: null,
      pullRequestUrl: null,
    },
    progress: {
      revision: 1,
      status: "running",
      threadId: "thread",
      detail: null,
      checkpoint: null,
      stepId: "push",
      generation: 0,
    },
    sequence: {
      cursor: 1,
      generation: 0,
      started: true,
      stepStartedAt: "now",
      completed: [{ stepId: "agent", generation: 0, checkpoint, head: "base" }],
      responses: [],
      feedback: null,
    },
    actions: [
      {
        actionId: id,
        stepId: "push",
        generation: 0,
        operation: "push",
        state: "running",
        phase: "prepare",
        parent: "base",
        tree: "prepared",
        checkpointRef: "refs/review",
        commitMessage: null,
        commitSha: null,
        oldRemoteSha: null,
        prTitle: null,
        prBody: null,
        pullRequestUrl: null,
        detail: null,
        commands: [],
      },
    ],
  });
}
const harness = (
  fault:
    | "none"
    | "commit-reply"
    | "push-reply"
    | "hook"
    | "ownership"
    | "ownership-no-boot"
    | "ownership-other-host"
    | "cancel"
    | "pr-reply"
    | "pr-invisible"
    | "pr-marker"
    | "pr-closed"
    | "pr-truncated"
    | "pr-foreign"
    | "pr-save" = "none",
) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initial());
    let saveFails = fault === "pr-save";
    const io: WorkflowActionIO = {
      read: Ref.get(state),
      update: (change) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) => {
            const next = change(current);
            if (
              saveFails &&
              next.actions?.some(
                (action) =>
                  action.operation === "open_pull_request" && action.state === "completed",
              )
            ) {
              saveFails = false;
              return Effect.fail(new WorkflowActionError({ message: "Lost save" }));
            }
            return Ref.set(state, next).pipe(Effect.as(next));
          }),
        ),
    };
    let head = "base";
    let parent = "base";
    let host = "host";
    let remote: string | null = null;
    let tree = "prepared";
    let dirty = true;
    let commits = 0;
    let pushes = 0;
    let creates = 0;
    let prExists = false;
    let marker = "<!-- launchpad-workflow-job:job -->";
    let knownRead = 0;
    const request = () => ({
      provider: "github" as const,
      number: 17,
      title: "Implement",
      url:
        fault === "pr-foreign"
          ? "https://github.com/other/repo/pull/17"
          : "https://github.com/acme/repo/pull/17",
      baseRefName: "main",
      headRefName: "t3-job/job",
      state: fault === "pr-closed" ? ("closed" as const) : ("open" as const),
      updatedAt: Option.none(),
      isCrossRepository: false,
      headRepositoryNameWithOwner: "acme/repo",
    });
    const provider = {
      kind: "github" as const,
      workflowPublishingTargeted: true,
      getChangeRequest: () =>
        Effect.sync(() => {
          knownRead++;
          return request();
        }),
      getChangeRequestDetails: () =>
        Effect.succeed({
          request: request(),
          body: fault === "pr-marker" ? "Edited externally" : marker,
          complete: fault !== "pr-truncated",
        }),
      listChangeRequests: () =>
        Effect.succeed(prExists && fault !== "pr-invisible" ? [request()] : []),
      createChangeRequest: (input: { baseRefName: string; headSelector: string }) =>
        Effect.gen(function* () {
          assert.equal(input.baseRefName, "main");
          assert.equal(input.headSelector, "t3-job/job");
          yield* invoke(
            Effect.sync(() => {
              creates++;
              prExists = true;
            }),
          );
          if (lose === "pr-reply") {
            lose = "none";
            return yield* Effect.die("Lost create reply");
          }
        }).pipe(
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "create",
                cwd: "/job",
                detail: "Create failed",
                cause,
              }),
          ),
        ),
    };
    let lose = fault;
    const stopFails = fault.startsWith("ownership");
    let session = "boot-1";
    const boot = () => (fault === "ownership-no-boot" ? null : { host, session });
    const invoke = <A>(body: Effect.Effect<A>) =>
      Effect.gen(function* () {
        const begin = yield* CurrentWorkflowCommand;
        assert.isNotNull(begin);
        const owner = yield* begin!;
        yield* owner.capture(42);
        yield* owner.arm;
        const result = yield* body;
        yield* owner.completed(0);
        yield* owner.stop;
        return result;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "test",
              command: "git",
              cwd: "/job",
              detail: "Owned command failed",
              cause,
            }),
        ),
      );
    const output = (stdout: string) => ({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const layers = Layer.mergeAll(
      Layer.mock(SetupProcessAdapter)({
        commandLauncher: Effect.succeed("native-owner"),
        host: Effect.sync(boot),
        inspect: () =>
          Effect.succeed({
            protocol: 4 as const,
            identity: "birth",
            owned: true,
            fullStop: false,
            boot: boot(),
          }),
        arm: () => Effect.succeed("git"),
        stop: () =>
          stopFails
            ? Effect.fail(new SetupProcessError({ message: "Ownership lost" }))
            : Effect.void,
      }),
      Layer.mock(SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        resolveHandle: (input) => {
          assert.equal(input.context?.repository, "github.com/acme/repo");
          assert.equal(input.context?.remoteName, "upstream");
          return Effect.succeed({
            provider: SourceControlProvider.of({
              ...provider,
              getRepositoryCloneUrls: () => Effect.die("unused"),
              createRepository: () => Effect.die("unused"),
              getDefaultBranch: () => Effect.die("unused"),
              checkoutChangeRequest: () => Effect.die("unused"),
            }),
            context: input.context ?? null,
          });
        },
      }),
      Layer.mock(RepositoryAccess)({ requireProject: () => Effect.void }),
      Layer.mock(CheckpointStore)({
        captureCheckpoint: () => Effect.void,
        deleteCheckpointRefs: () => Effect.void,
        diffCheckpoints: () => Effect.succeed(""),
      }),
      Layer.mock(GitManager)({
        prepareWorkflowPullRequest: () =>
          Effect.succeed({ title: "Implement", body: "Saved result" }),
        prepareWorkflowCommit: () =>
          invoke(Effect.succeed({ subject: "Implement", body: "Saved result" })),
      }),
      Layer.mock(GitVcsDriver)({
        statusDetailsLocal: () =>
          Effect.succeed({
            isRepo: true,
            hasOriginRemote: true,
            isDefaultBranch: false,
            branch: "t3-job/job",
            upstreamRef: null,
            hasWorkingTreeChanges: dirty,
            workingTree: { insertions: 0, deletions: 0, files: [] },
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
          }),
        execute: (input) =>
          Effect.gen(function* () {
            const args = input.args;
            if (args[0] === "ls-remote")
              return output(remote ? `${remote}\trefs/heads/t3-job/job\n` : "");
            if (args[0] === "write-tree") return output(tree);
            if (args[0] === "show")
              return output(args[2] === "--format=%P" ? parent : "Implement\n\nSaved result");
            if (args[0] === "rev-parse")
              return output(
                args[1] === "HEAD" ? head : args[1] === "base^{tree}" ? "base-tree" : tree,
              );
            if (args[0] === "merge-base") return output("");
            if (args[0] === "push") {
              assert.equal(args.at(-2), "https://github.com/acme/repo.git");
              assert.equal(args.at(-1), `${head}:refs/heads/t3-job/job`);
              const result = yield* invoke(
                Effect.sync(() => {
                  pushes++;
                  remote = head;
                  return output("");
                }),
              );
              if (lose === "push-reply") {
                lose = "none";
                return yield* Effect.die("Lost Push reply");
              }
              return result;
            }
            return yield* Effect.die(`Unexpected Git command: ${args[0]}`);
          }),
        commit: () =>
          Effect.gen(function* () {
            const result = yield* invoke(
              Effect.gen(function* () {
                commits++;
                parent = head;
                head = commits === 1 ? "commit" : `commit-${commits}`;
                dirty = false;
                if (lose === "hook") tree = "unreviewed";
                if (lose === "cancel")
                  yield* Ref.update(state, (run) => ({
                    ...run,
                    progress: { ...run.progress, status: "cancelling" as const },
                  }));
                return { commitSha: head };
              }),
            );
            if (lose === "commit-reply") {
              lose = "none";
              return yield* Effect.die("Lost commit reply");
            }
            return result;
          }),
      }),
    );
    const actions = yield* make.pipe(Effect.provide(layers));
    const beginPr = (generation = 0) =>
      io.update((run) => ({
        ...run,
        workflow: {
          ...run.workflow,
          definition: {
            ...run.workflow.definition,
            steps: [
              ...run.workflow.definition.steps.filter((step) => step.id !== "pr"),
              {
                id: "pr",
                kind: "action" as const,
                title: "Open PR",
                action: "open_pull_request" as const,
              },
            ],
          },
        },
        sequence: { ...run.sequence!, cursor: 2, generation },
        progress: { ...run.progress, stepId: "pr", generation },
        actions: [
          ...run.actions!,
          {
            ...run.actions!.findLast((action) => action.operation === "push")!,
            actionId: `pr:${generation}`,
            stepId: "pr",
            generation,
            operation: "open_pull_request" as const,
            state: "running" as const,
            phase: "prepare" as const,
            parent: run.preparedHead!,
            commitSha: null,
            commands: [],
            pullRequestUrl: null,
          },
        ],
      }));
    const beginRework = () =>
      Effect.gen(function* () {
        dirty = true;
        tree = "prepared-2";
        yield* io.update((run) => ({
          ...run,
          sequence: { ...run.sequence!, cursor: 1, generation: 1 },
          progress: { ...run.progress, stepId: "push", generation: 1 },
          actions: [
            ...run.actions!,
            {
              ...run.actions!.findLast((action) => action.operation === "push")!,
              actionId: "push:1",
              generation: 1,
              state: "running",
              phase: "prepare",
              parent: head,
              tree,
              commitMessage: null,
              commitSha: null,
              oldRemoteSha: run.publication!.publishedHead,
              commands: [],
            },
          ],
        }));
      });
    return {
      actions,
      io,
      state,
      beginPr,
      beginRework,
      prCounts: () => ({ creates, knownRead }),
      editBody: () => {
        marker = "Edited after creation";
      },
      counts: () => ({ commits, pushes }),
      recoverAfterBoot: () => {
        session = "boot-2";
        if (fault === "ownership-other-host") host = "other-host";
      },
    };
  });

it.effect("publishes the pinned commit once and observes completion on replay", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.actions.execute(id, h.io);
    yield* h.actions.execute(id, h.io);
    assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
    const run = yield* h.io.read;
    assert.equal(run.actions![0]!.state, "completed");
    assert.equal(run.preparedHead, "commit");
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
    assert.equal(run.publication?.publishedHead, "commit-2");
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
