import {
  EnvironmentAuthorizationError,
  GitCommandError,
  SourceControlProviderError,
} from "@t3tools/contracts";
import { assert } from "@effect/vitest";
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

export const id = "workflow:job:action:push:0";
const decodeRun = Schema.decodeUnknownSync(WorkflowRun);
export function initial() {
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
export const harness = (
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
  binding?: {
    jobId: string;
    base: string;
    tree: string;
    remoteName: string;
    access: import("../auth/RepositoryAccess.ts").RepositoryAccessShape;
    onHead: (sha: string) => Effect.Effect<void>;
    beforeArm?: Effect.Effect<void, EnvironmentAuthorizationError>;
  },
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
    const branchName = `t3-job/${binding?.jobId ?? "job"}`;
    let head = binding?.base ?? "base";
    let parent = head;
    let host = "host";
    let remote: string | null = null;
    let tree = binding?.tree ?? "prepared";
    let dirty = true;
    let deliveries = 0;
    let commits = 0;
    let pushes = 0;
    let creates = 0;
    let prExists = false;
    let marker = `<!-- launchpad-workflow-job:${binding?.jobId ?? "job"} -->`;
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
      headRefName: branchName,
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
          assert.equal(input.headSelector, branchName);
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
        if (binding?.beforeArm) yield* binding.beforeArm;
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
        arm: () =>
          Effect.sync(() => {
            deliveries++;
            return "git";
          }),
        stop: () =>
          stopFails
            ? Effect.fail(new SetupProcessError({ message: "Ownership lost" }))
            : Effect.void,
      }),
      Layer.mock(SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        resolveHandle: (input) => {
          assert.equal(input.context?.repository, "github.com/acme/repo");
          assert.equal(input.context?.remoteName, binding?.remoteName ?? "upstream");
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
      binding
        ? Layer.succeed(RepositoryAccess, binding.access)
        : Layer.mock(RepositoryAccess)({
            withFence: (effect) => effect,
            requireProject: () => Effect.void,
          }),
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
            branch: branchName,
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
              return output(remote ? `${remote}\trefs/heads/${branchName}\n` : "");
            if (args[0] === "write-tree") return output(tree);
            if (args[0] === "show")
              return output(args[2] === "--format=%P" ? parent : "Implement\n\nSaved result");
            if (args[0] === "rev-parse")
              return output(
                args[1] === "HEAD"
                  ? head
                  : args[1] === `${binding?.base ?? "base"}^{tree}`
                    ? "base-tree"
                    : tree,
              );
            if (args[0] === "merge-base") return output("");
            if (args[0] === "push") {
              assert.equal(args.at(-2), "https://github.com/acme/repo.git");
              assert.equal(args.at(-1), `${head}:refs/heads/${branchName}`);
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
                if (binding) yield* binding.onHead(head);
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
      commandDeliveries: () => deliveries,
      recoverAfterBoot: () => {
        session = "boot-2";
        if (fault === "ownership-other-host") host = "other-host";
      },
    };
  });
