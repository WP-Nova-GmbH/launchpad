import * as NodeCrypto from "node:crypto";
import type {
  CodexConversationManifest,
  RelayThreadVmRestoreRecovery,
} from "@t3tools/contracts/relay";
import {
  WorkflowVmDispatchBinding,
  type WorkflowVmPublishingAction,
  type WorkflowVmPublishingRestore,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import { WorkflowRunRecovery, type WorkflowActionRecord } from "../jobs/WorkflowRunStore.ts";
import {
  requireWorkflowVmLifecycleCheckpoint,
  matchesWorkflowVmLifecycleCheckpoint,
} from "../persistence/WorkflowThreadOwnership.ts";
import { workspaceGitText } from "./ThreadWorkspaceGit.ts";
import { makeThreadCheckoutClaims } from "./ThreadCheckoutClaim.ts";
import { VmCoordinatorProcess, workflowVmBaseEnvironment } from "../vmWorkloadCommand.ts";
import { stageWorkflowCheckpoint } from "../vcs/WorkflowCheckpointReader.ts";
import { syncThreadArtifactPath } from "./ThreadArtifactDurability.ts";

const decodeCapsule = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRunRecovery));
const sameBinding = Schema.toEquivalence(WorkflowVmDispatchBinding);
class ThreadVmWorkflowRestoreError extends Schema.TaggedError<ThreadVmWorkflowRestoreError>()(
  "ThreadVmWorkflowRestoreError",
  {},
) {
  override get message() {
    return "The saved workflow state does not match this VM recovery.";
  }
}
const fail = () => new ThreadVmWorkflowRestoreError();
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
type WorkflowRecovery = NonNullable<RelayThreadVmRestoreRecovery["workflow"]>;

function restoredPublishingAction(
  action: WorkflowVmPublishingAction,
  state: "uncertain" | "completed",
  pullRequestUrl = action.pullRequestUrl,
): WorkflowActionRecord {
  return {
    actionId: action.actionId,
    stepId: action.stepId,
    generation: action.stepGeneration,
    operation: action.operation,
    state,
    phase: state === "completed" ? "done" : action.operation === "push" ? "push" : "pull_request",
    parent: action.parent,
    tree: action.tree,
    checkpointRef: action.checkpointRef,
    checkpointTurnId: action.resultTurnId,
    commitMessage: null,
    commitSha: action.commitSha,
    oldRemoteSha: action.oldRemoteSha,
    prTitle: null,
    prBody: null,
    pullRequestUrl,
    detail: null,
    commands: [],
  };
}

/** Move the sealed checkpoint forward only through recorded responses and publishing receipts. */
export function restoreWorkflowPublishingAction(
  capsule: WorkflowRunRecovery,
  publishing: WorkflowVmPublishingRestore,
): WorkflowRunRecovery | null {
  const run = capsule.run;
  const { action, outcome, previousPush } = publishing;
  const sequence = run.sequence;
  const latest = sequence?.completed.findLast((entry) => entry.checkpoint)?.checkpoint;
  const steps = run.workflow.definition.steps;
  const cursor = steps.findIndex((step) => step.id === action.stepId);
  const target = steps[cursor];
  if (
    !sequence ||
    !latest ||
    !run.publication ||
    !run.preparedHead ||
    publishing.expectedRevision < run.progress.revision ||
    action.stepGeneration !== sequence.generation ||
    action.actionId !== `workflow:${run.jobId}:action:${action.stepId}:${sequence.generation}` ||
    cursor <= sequence.cursor ||
    target?.kind !== "action" ||
    target.action !== action.operation ||
    latest.turnId !== action.resultTurnId ||
    latest.checkpointRef !== action.checkpointRef ||
    !capsule.checkpointPins.some(
      (pin) =>
        pin.turnId === action.resultTurnId &&
        pin.checkpointRef === action.checkpointRef &&
        pin.treeId === action.tree,
    ) ||
    (outcome && outcome.commitSha !== action.commitSha)
  )
    return null;
  const responses = [...sequence.responses];
  const completed = [...sequence.completed];
  const actions = [...(run.actions ?? [])];
  let preparedHead = run.preparedHead;
  let pullRequestUrl = run.publication.pullRequestUrl;
  let publishedHead = run.publication.publishedHead;
  for (const step of steps.slice(sequence.cursor, cursor)) {
    if (step.kind === "agent") return null;
    if (step.kind === "action") {
      const receipt = publishing.completedActions.find(
        (entry) =>
          entry.stepId === step.id &&
          entry.stepGeneration === sequence.generation &&
          entry.operation === step.action,
      );
      if (
        !receipt ||
        receipt.actionId !== `workflow:${run.jobId}:action:${step.id}:${sequence.generation}` ||
        receipt.resultTurnId !== action.resultTurnId ||
        receipt.checkpointRef !== action.checkpointRef ||
        receipt.tree !== action.tree ||
        receipt.parent !== preparedHead ||
        receipt.commitSha !== receipt.outcome.commitSha
      )
        return null;
      actions.push(restoredPublishingAction(receipt, "completed", receipt.outcome.pullRequestUrl));
      if (receipt.operation === "push") preparedHead = publishedHead = receipt.outcome.commitSha;
      pullRequestUrl = receipt.outcome.pullRequestUrl ?? pullRequestUrl;
    } else {
      const id = `workflow:${run.jobId}:checkpoint:${step.id}:${sequence.generation}`;
      const response = publishing.responses.find(
        (entry) =>
          entry.checkpointId === id &&
          entry.stepId === step.id &&
          entry.generation === sequence.generation &&
          entry.operation === (step.kind === "review" ? "approve" : "input"),
      );
      if (!response) return null;
      if (!responses.some((entry) => entry.checkpointId === id)) responses.push(response);
    }
    completed.push({
      stepId: step.id,
      generation: sequence.generation,
      checkpoint: null,
      head: preparedHead,
    });
  }
  if (action.parent !== preparedHead || action.oldRemoteSha !== publishedHead) return null;
  let commitSha = action.commitSha;
  if (action.operation === "open_pull_request") {
    if (
      !previousPush ||
      previousPush.operation !== "push" ||
      previousPush.resultTurnId !== action.resultTurnId ||
      previousPush.checkpointRef !== action.checkpointRef ||
      previousPush.tree !== action.tree ||
      previousPush.commitSha !== previousPush.outcome.commitSha ||
      (commitSha !== null && commitSha !== previousPush.outcome.commitSha) ||
      previousPush.outcome.commitSha !== publishedHead
    )
      return null;
    if (!actions.some((entry) => entry.actionId === previousPush.actionId))
      actions.push(restoredPublishingAction(previousPush, "completed"));
    // A read credential can record Open PR before it binds the pushed commit.
    commitSha = previousPush.outcome.commitSha;
  }
  const detail = "The workflow VM recovered the saved result. Retry publishing to verify GitHub.";
  return {
    ...capsule,
    run: {
      ...run,
      actions: [
        ...actions.filter((entry) => entry.actionId !== action.actionId),
        restoredPublishingAction(
          { ...action, commitSha },
          "uncertain",
          outcome?.pullRequestUrl ?? action.pullRequestUrl,
        ),
      ],
      publication: {
        ...run.publication,
        publishedHead,
        pullRequestUrl: outcome?.pullRequestUrl ?? action.pullRequestUrl ?? pullRequestUrl,
      },
      preparedHead,
      sequence: { ...sequence, cursor, completed, responses, feedback: null },
      progress: {
        ...run.progress,
        revision: publishing.expectedRevision,
        stepId: action.stepId,
        status: "paused",
        underlyingStatus: "paused",
        checkpoint: null,
        detail,
        approvalPending: false,
      },
    },
  };
}

/** Check the workload-owned home the next Agent actually uses. Archived roots
 * and immutable history prefixes are read through the fixed guest reader. */
export const verifyRestoredWorkflowNativeHome = Effect.fn(
  "ThreadVmWorkflowRestore.verifyNativeHome",
)(function* (manifest: CodexConversationManifest, scratch: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = workflowVmBaseEnvironment.CODEX_HOME;
  const heads = new Set([manifest.rolloutName, ...Object.values(manifest.heads ?? {})]);
  const rollouts = (
    manifest.rollouts ?? [
      {
        rolloutName: manifest.rolloutName,
        sha256: manifest.sha256,
        sizeBytes: null,
      },
    ]
  ).map(({ rolloutName, sha256, sizeBytes }) => ({
    candidates: [
      path.join("sessions", ...rolloutName.slice(8, 18).split("-"), rolloutName),
      path.join("archived_sessions", rolloutName),
    ],
    sha256,
    sizeBytes,
    exactSize: heads.has(rolloutName),
  }));
  const references = (manifest.files ?? [])
    .filter(({ sourcePath }) => sourcePath.startsWith(path.join(home, "native-files") + path.sep))
    .map(({ sourcePath, sha256, sizeBytes }) => ({
      candidates: [path.relative(home, sourcePath)],
      sha256,
      sizeBytes,
      exactSize: true,
    }));
  const files = [...rollouts, ...references];
  const snapshot = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({
      directory: scratch,
      prefix: "workflow-native-proof-",
    }),
  );
  yield* stageWorkflowCheckpoint(spawner, home, snapshot, [
    ...new Set(files.flatMap(({ candidates }) => candidates)),
  ]);
  for (const proof of files) {
    const existing = yield* Effect.filter(proof.candidates, (relative) =>
      fs.exists(path.join(snapshot, relative)),
    );
    if (existing.length !== 1) return yield* fail();
    const file = path.join(snapshot, existing[0]!);
    const stat = yield* fs.stat(file);
    const actualSize = Number(stat.size);
    const expectedSize = proof.sizeBytes ?? actualSize;
    if (
      (yield* fs.realPath(file)) !== file ||
      stat.type !== "File" ||
      expectedSize > 64 * 1024 * 1024 ||
      actualSize < expectedSize ||
      (proof.exactSize && actualSize !== expectedSize)
    )
      return yield* fail();
    const digest = NodeCrypto.createHash("sha256");
    if (expectedSize > 0)
      yield* fs.stream(file, { bytesToRead: expectedSize }).pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            digest.update(chunk);
          }),
        ),
      );
    if (digest.digest("hex") !== proof.sha256) return yield* fail();
  }
});

export const readWorkflowVmRecoveryCapsule = Effect.fn("ThreadVmWorkflowRestore.readCapsule")(
  function* <E, R>(workflow: WorkflowRecovery, stream: Stream.Stream<Uint8Array, E, R>) {
    const { checkpoint, manifest, binding } = workflow;
    if (
      manifest.publicationId !== checkpoint.publicationId ||
      manifest.revision !== checkpoint.publicationRevision ||
      manifest.sourceSequence > workflow.sourceSequence ||
      manifest.binding.jobId !== binding.jobId ||
      binding.jobId !== checkpoint.jobId ||
      manifest.binding.threadId !== binding.threadId ||
      manifest.binding.repositoryId !== binding.repositoryId ||
      manifest.binding.organizationId !== binding.organizationId ||
      manifest.binding.projectId !== binding.projectId ||
      manifest.binding.generation >= binding.generation ||
      manifest.binding.allocationId === binding.allocationId ||
      manifest.binding.operationId === binding.operationId ||
      manifest.binding.environmentId === binding.environmentId ||
      manifest.state.sizeBytes > 2_000_000
    )
      return yield* Effect.fail(fail());
    let length = 0;
    const parts = yield* stream.pipe(
      Stream.mapEffect((part) => {
        length += part.length;
        return length > manifest.state.sizeBytes ? Effect.fail(fail()) : Effect.succeed(part);
      }),
      Stream.runCollect,
      Effect.timeout("2 minutes"),
    );
    const bytes = Buffer.concat(parts, length);
    if (
      bytes.length !== manifest.state.sizeBytes ||
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== manifest.state.sha256
    )
      return yield* Effect.fail(fail());
    const record = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: fail,
    });
    const capsule = yield* decodeCapsule(record);
    if (
      capsule.run.runtime.kind !== "vm" ||
      !sameBinding(capsule.run.runtime, manifest.binding) ||
      !matchesWorkflowVmLifecycleCheckpoint(capsule.run, checkpoint) ||
      capsule.frozenConfiguration.jobId !== binding.jobId ||
      capsule.frozenConfiguration.repositoryId !== binding.repositoryId ||
      capsule.checkpointPins.some(
        (pin) =>
          !oid.test(pin.commitId) ||
          !oid.test(pin.treeId) ||
          !oid.test(pin.baselineCommitId) ||
          !pin.checkpointRef.startsWith("refs/t3/"),
      ) ||
      (capsule.workflowIgnoreRulesBase64 !== null &&
        Buffer.from(capsule.workflowIgnoreRulesBase64, "base64").toString("base64") !==
          capsule.workflowIgnoreRulesBase64)
    )
      return yield* Effect.fail(fail());
    if (!workflow.publishing) return capsule;
    if (workflow.publishing.latestPublicationRevision < checkpoint.publicationRevision)
      return yield* Effect.fail(fail());
    const restored = restoreWorkflowPublishingAction(capsule, workflow.publishing);
    if (!restored) return yield* Effect.fail(fail());
    return restored;
  },
);

/** The saved bare review repository belongs to the coordinator, outside the workload checkout. */
export const recoverWorkflowReviewGit = Effect.fn("ThreadVmWorkflowRestore.reviewGit")(
  function* (input: {
    baseDir: string;
    stateDir: string;
    allocationId: string;
    capsule: WorkflowRunRecovery;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = path.join(`${input.baseDir}-restores`, input.allocationId, "source", "userdata");
    const previous = path.join(source, "workflow-review.git");
    const current = path.join(input.stateDir, "workflow-review.git");
    const git = (args: ReadonlyArray<string>) =>
      workspaceGitText(input.stateDir, ["--git-dir=" + current, ...args]).pipe(
        Effect.provideService(VmCoordinatorProcess, true),
      );
    if (yield* fs.exists(previous)) {
      if (
        (yield* fs.realPath(previous)) !== previous ||
        (yield* fs.stat(previous)).type !== "Directory" ||
        (yield* fs.exists(current))
      )
        return yield* Effect.fail(fail());
      yield* fs.rename(previous, current);
      yield* syncThreadArtifactPath(source);
      yield* syncThreadArtifactPath(input.stateDir);
    }
    if (
      (yield* fs.realPath(current)) !== current ||
      (yield* git(["rev-parse", "--is-bare-repository"])) !== "true"
    )
      return yield* Effect.fail(fail());
    for (const pin of input.capsule.checkpointPins) {
      const resolve = (ref: string) => git(["rev-parse", "--verify", "--end-of-options", ref]);
      if (
        (yield* resolve(pin.checkpointRef + "^{commit}")) !== pin.commitId ||
        (yield* resolve(pin.commitId + "^{tree}")) !== pin.treeId ||
        (yield* resolve(pin.baselineCommitId + "^{commit}")) !== pin.baselineCommitId
      )
        return yield* Effect.fail(fail());
    }
  },
);

/** Workflow setup already ran on the saved disk. Validate the installed frozen
 * run and its saved native identity without replaying its project recipe. */
export const assertWorkflowVmRestoreReady = Effect.fn("ThreadVmWorkflowRestore.assertReady")(
  function* (recovery: RelayThreadVmRestoreRecovery, manifestSha256: string) {
    const workflow = recovery.workflow;
    if (!workflow) return yield* Effect.fail(fail());
    const sql = yield* SqlClient.SqlClient;
    const lifecycle = yield* requireWorkflowVmLifecycleCheckpoint(sql, {
      threadId: workflow.binding.threadId,
      generation: workflow.binding.generation,
      workflowCheckpoint: workflow.checkpoint,
      ...(workflow.publishing ? { publishing: workflow.publishing } : {}),
    });
    const claim = yield* makeThreadCheckoutClaims(sql).get(recovery.operationId);
    const fs = yield* FileSystem.FileSystem;
    if (
      !sameBinding(lifecycle.binding, workflow.binding) ||
      !claim ||
      claim.phase !== "installed" ||
      claim.manifestSha256 !== manifestSha256 ||
      claim.threadId !== workflow.binding.threadId ||
      claim.projectId !== workflow.binding.projectId ||
      claim.generation !== workflow.binding.generation ||
      (yield* fs.realPath(claim.repositoryRoot)) !== claim.repositoryRoot ||
      (yield* fs.realPath(claim.checkoutPath)) !== claim.checkoutPath
    )
      return yield* Effect.fail(fail());
    const [runtime] = yield* sql<{ cursor: string | null }>`SELECT resume_cursor_json AS cursor
      FROM provider_session_runtime WHERE thread_id=${workflow.binding.threadId}`;
    const [verified] = yield* sql`SELECT 1 FROM provider_session_runtime
      WHERE thread_id=${workflow.binding.threadId} AND provider_name='codex' AND adapter_key='codex'
        AND provider_instance_id='codex' AND status='stopped'
        AND json_extract(resume_cursor_json,'$.threadId')=${recovery.native?.nativeThreadId ?? null}
        AND json_extract(resume_cursor_json,'$.resumePolicy')='require-existing'
        AND (${workflow.checkpoint.finishedWorkspaceRevision !== undefined}
          OR json_extract(runtime_payload_json,'$.providerContinuation.workflowJobId')=${workflow.binding.jobId})
        AND json_extract(runtime_payload_json,'$.stoppedRuntimeEventsDrained')=1`;
    if (recovery.native ? !verified : !lifecycle.beforeAgent || runtime !== undefined)
      return yield* Effect.fail(fail());
  },
);
