import { assertWorkflowThreadReleased } from "../persistence/WorkflowThreadOwnership.ts";
import { configureThreadVmMoveRepository } from "./ThreadVmRepositoryBinding.ts";
import { makeThreadMoveProgress } from "./ThreadMoveProgress.ts";
import { prepareThreadVmMoveWorkspace } from "./ThreadVmMoveWorkspace.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  CommandId,
  ModelSelection,
  ThreadId,
  ThreadPromptQueue,
  OrchestrationSession,
} from "@t3tools/contracts";
import {
  ThreadTransferChunkManifest,
  CODEX_CONVERSATION_TRANSFER_VERSION,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { CheckoutCaptureError, makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProcessRunner } from "../processRunner.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { inspectVmWorkloads } from "../vmWorkload.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { resolveCheckoutPath } from "../workspace/CheckoutAccess.ts";
import { notifyCheckoutCaptureReleased } from "../workspace/CheckoutCaptureSignals.ts";
import {
  makeThreadTransferArchive,
  ThreadTransferArchiveManifest,
  stageThreadTransferArchive,
} from "./ThreadTransferArchive.ts";
import {
  materializeThreadTransferChunks,
  packThreadTransferArchive,
} from "./ThreadTransferChunks.ts";
import { installThreadTransferArchive } from "./ThreadTransferInstall.ts";
import { prepareThreadTransfer } from "./ThreadTransferReadiness.ts";
import { ThreadExecution } from "./ThreadExecution.ts";
import { makeThreadCheckoutClaims } from "./ThreadCheckoutClaim.ts";
import { makeThreadCheckoutInstaller } from "./ThreadCheckoutInstall.ts";
import { workspaceFileHash } from "./ThreadWorkspaceFiles.ts";
import { workspaceGitText } from "./ThreadWorkspaceGit.ts";
import { makeThreadTransferAborts } from "./ThreadTransferAbort.ts";
import {
  ThreadMoveError,
  THREAD_MOVE_ARTIFACT_TIMEOUT,
  assertThreadMoveIdentity,
  type ThreadMoveOwner,
  type ThreadMoveTransport,
} from "./ThreadMoveTransport.ts";
import type { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import type { makeThreadCommandSync } from "./ThreadCommandSync.ts";

const decodeQueue = Schema.decodeEffect(Schema.fromJsonString(ThreadPromptQueue));
const decodeModel = Schema.decodeEffect(Schema.fromJsonString(ModelSelection));
const decodeArchive = Schema.decodeEffect(Schema.fromJsonString(ThreadTransferArchiveManifest));
const decodeSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeChunks = Schema.decodeEffect(Schema.fromJsonString(ThreadTransferChunkManifest));
const hasErrorDetail = Schema.is(Schema.Struct({ detail: Schema.NonEmptyString }));
const hasErrorMessage = Schema.is(Schema.Struct({ message: Schema.NonEmptyString }));
const failureDetail = (error: unknown) =>
  (hasErrorDetail(error)
    ? error.detail
    : hasErrorMessage(error)
      ? error.message
      : "The thread move could not be prepared."
  )
    .trim()
    .split(/[\r\n]/u)[0]!
    .slice(0, 2000)
    .trim() || "The thread move could not be prepared.";

/** One durable operation drives each queued move. Slow transfer work runs in its
 * own server worker; the relay inbox and history loops remain responsive. */
export const makeThreadMoveWorker = Effect.fn("ThreadMoveWorker.make")(function* (
  transport: ThreadMoveTransport,
  history: ReturnType<typeof makeThreadHistorySync>,
  commands: ReturnType<typeof makeThreadCommandSync>,
) {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* OrchestrationEngineService;
  const background = yield* ThreadBackgroundLivenessService;
  const provider = yield* ProviderService;
  const runner = yield* ProcessRunner;
  const registry = yield* ProviderInstanceRegistry;
  const tracked = yield* VmWorkloadTracking;
  const terminals = yield* TerminalManager;
  const execution = yield* ThreadExecution;
  const repositories = yield* RepositoryIdentityResolver;
  const archive = makeThreadTransferArchive(sql, yield* OrchestrationEventStore);
  const fences = makeThreadExecutionFence(sql),
    claims = makeThreadCheckoutClaims(sql),
    captures = makeCheckoutCapture(sql);
  const context = yield* Effect.context<
    | Effect.Services<ReturnType<typeof configureThreadVmMoveRepository>>
    | Effect.Services<ReturnType<typeof prepareThreadVmMoveWorkspace>>
    | Effect.Services<ReturnType<typeof archive.exportSource>>
    | Effect.Services<ReturnType<typeof stageThreadTransferArchive>>
    | Effect.Services<ReturnType<typeof installThreadTransferArchive>>
    | Effect.Services<ReturnType<typeof prepareThreadTransfer>>
    | Effect.Services<ReturnType<ReturnType<typeof makeThreadCheckoutInstaller>["rollback"]>>
  >();
  const storageRoot = path.join(config.stateDir, "move-transfers");
  yield* fs.makeDirectory(storageRoot, { recursive: true, mode: 0o700 });
  const root = yield* fs.realPath(storageRoot);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fail = (threadId: string, detail: string) => new ThreadMoveError({ threadId, detail });
  const readQueue = Effect.fnUntraced(function* (threadId: string) {
    const [row] = yield* sql<{ queue: string; model: string; archivedAt: string | null }>`SELECT
      q.state_json AS queue,t.model_selection_json AS model,t.archived_at AS "archivedAt"
      FROM projection_thread_prompt_queues q JOIN projection_threads t USING(thread_id)
      WHERE q.thread_id=${threadId} AND t.deleted_at IS NULL`;
    return row
      ? {
          queue: yield* decodeQueue(row.queue),
          model: yield* decodeModel(row.model),
          archivedAt: row.archivedAt,
        }
      : null;
  });
  const operationPath = (owner: ThreadMoveOwner, side: "source" | "destination") => {
    if (!/^[0-9a-f-]{36}$/u.test(owner.operationId)) throw new Error("Invalid move operation ID");
    return path.join(root, side, owner.operationId);
  };
  const syncArchiveParent = (directory: string) =>
    Effect.scoped(
      fs.open(path.dirname(directory), { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
    );
  const inspectArchive = Effect.fnUntraced(function* (owner: ThreadMoveOwner, directory: string) {
    if ((yield* fs.realPath(directory)) !== directory)
      return yield* fail(owner.threadId, "Move storage cannot follow a linked directory.");
    const manifestPath = path.join(directory, "manifest.json");
    const digest = (yield* workspaceFileHash(manifestPath)).sha256;
    const manifest = yield* decodeArchive(yield* fs.readFileString(manifestPath));
    return { directory, manifest, sha256: digest };
  });
  const sourceArchive = Effect.fnUntraced(function* (
    owner: ThreadMoveOwner,
    sealedSha256?: string,
  ) {
    const target = operationPath(owner, "source");
    if (yield* fs.exists(target)) {
      const saved = yield* inspectArchive(owner, target);
      if (sealedSha256 !== undefined && saved.sha256 !== sealedSha256)
        return yield* fail(
          owner.threadId,
          "The sealed source archive changed. Restore its saved bytes before retrying.",
        );
      yield* syncArchiveParent(target);
      return saved;
    }
    if (sealedSha256 !== undefined)
      return yield* fail(
        owner.threadId,
        "The sealed source archive is missing. Restore its saved bytes before retrying.",
      );
    const exported = yield* archive
      .exportSource(
        {
          ...owner,
          artifactRoot: path.join(root, "staging"),
          attachmentsDir: config.attachmentsDir,
          serverDataRoot: config.stateDir,
        },
        provider,
      )
      .pipe(Effect.provideContext(context));
    yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
    yield* fs.rename(exported.directory, target);
    yield* syncArchiveParent(target);
    return { ...exported, directory: target };
  });
  const verifySourceOwner = Effect.fnUntraced(function* (
    owner: ThreadMoveOwner,
    saved: Effect.Success<ReturnType<typeof sourceArchive>>,
  ) {
    const current = yield* fences.get(owner.threadId);
    if (
      current?.phase !== "frozen" ||
      current.operationId !== owner.operationId ||
      saved.manifest.history.threadId !== owner.threadId ||
      saved.manifest.history.operationId !== owner.operationId ||
      saved.manifest.history.generation !== owner.generation ||
      saved.manifest.history.environmentId !== owner.environmentId ||
      saved.manifest.history.sourceSequence !== current.frozenSequence
    )
      return yield* fail(owner.threadId, "The source archive does not match its frozen ownership.");
  });
  const within = (root: string, candidate: string) =>
    candidate === root ||
    candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  const readCheckoutBindings = () => sql<{ threadId: string; projectId: string; root: string }>`
    SELECT t.thread_id AS "threadId",t.project_id AS "projectId",COALESCE(t.worktree_path,p.workspace_root) AS root
    FROM projection_threads t JOIN projection_projects p USING(project_id)
    WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY t.thread_id`;
  const prepareCapture = Effect.fnUntraced(function* (owner: ThreadMoveOwner) {
    const bindings = yield* readCheckoutBindings();
    const binding = bindings.find((row) => row.threadId === owner.threadId);
    if (!binding)
      return yield* fail(owner.threadId, "The source checkout is no longer registered.");
    const checkoutRoot = yield* fs.realPath(binding.root);
    const top = yield* fs.realPath(
      yield* workspaceGitText(checkoutRoot, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.provideService(ProcessRunner, runner),
      ),
    );
    if (top !== checkoutRoot)
      return yield* fail(owner.threadId, "Transfer must start at the repository checkout root.");
    const gitCommonRoot = yield* fs.realPath(
      yield* workspaceGitText(checkoutRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).pipe(Effect.provideService(ProcessRunner, runner)),
    );
    const sharedThreadIds: string[] = [];
    for (const row of bindings) {
      const candidate = yield* resolveCheckoutPath(row.root, fs, path);
      if (within(checkoutRoot, candidate) || within(candidate, checkoutRoot))
        sharedThreadIds.push(row.threadId);
    }
    return { bindings, sharedThreadIds, checkoutRoot, gitCommonRoot };
  });
  const checkoutNotice = Effect.fnUntraced(function* (
    owner: ThreadMoveOwner,
    waitingForCheckout: boolean,
    detail: string,
  ) {
    const fence = yield* fences.get(owner.threadId);
    // A frozen thread's event head is part of its immutable source archive.
    if (fence?.phase !== "draining") return;
    const head = (yield* readQueue(owner.threadId))?.queue.entries[0];
    if (
      !head ||
      head.kind !== "move" ||
      head.operationId !== owner.operationId ||
      head.state === "cancelling"
    )
      return;
    if (
      waitingForCheckout
        ? head.waitingForCheckout && head.detail === detail
        : !head.waitingForCheckout
    )
      return;
    yield* engine.dispatch({
      type: "thread.move.progress",
      threadId: ThreadId.make(owner.threadId),
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      messageId: head.messageId,
      operationId: CommandId.make(owner.operationId),
      expectedRevision: head.revision,
      blocked: false,
      waitingForCheckout,
      detail,
      createdAt: yield* now,
    });
  });
  const releaseCapture = Effect.fnUntraced(function* (
    owner: ThreadMoveOwner,
    outcome: "failed" | "cancelled",
  ) {
    const hold = yield* captures.get(owner.operationId);
    if (!hold || hold.phase === "released") return;
    // A persisted capture can outlive its process reply. Cancellation must not
    // reopen the checkout while that copy's completion is still uncertain.
    if (hold.phase === "capturing") {
      const target = operationPath(owner, "source");
      if (!(yield* fs.exists(target))) return;
      // The final rename follows export verification and the artifact-tree
      // durability receipt. Recover a crash before the SQL seal receipt.
      const saved = yield* inspectArchive(owner, target);
      yield* verifySourceOwner(owner, saved);
      yield* syncArchiveParent(target);
      yield* captures.release(owner, { outcome: "sealed", manifestSha256: saved.sha256 });
    } else yield* captures.release(owner, { outcome });
    yield* notifyCheckoutCaptureReleased(sql, hold.checkoutRoot);
  });
  const enterCapture = Effect.fnUntraced(function* (
    owner: ThreadMoveOwner,
    prepared: Effect.Success<ReturnType<typeof prepareCapture>>,
  ) {
    const live = yield* provider.listSessions();
    const ids = prepared.sharedThreadIds;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!NodeUtil.isDeepStrictEqual(yield* readCheckoutBindings(), prepared.bindings))
          return yield* new CheckoutCaptureError({
            message: "Checkout registrations changed while preparing the snapshot.",
            waitingForCheckout: true,
          });
        const busy = yield* sql<{
          threadId: string;
          reason: string;
        }>`SELECT thread_id AS "threadId",
          CASE WHEN completed_at IS NULL OR state IN ('pending','running') THEN 'finish its current turn' ELSE 'finish its checkpoint' END AS reason
          FROM projection_turns WHERE thread_id IN ${sql.in(ids)}
        AND (completed_at IS NULL OR state IN ('pending','running') OR checkpoint_status='pending')
        UNION ALL SELECT thread_id AS "threadId",CASE kind WHEN 'terminal' THEN 'confirm its terminal has stopped'
          WHEN 'setup' THEN 'confirm its setup has stopped' ELSE 'finish its workspace operation' END AS reason
          FROM thread_execution_work WHERE thread_id IN ${sql.in(ids)} AND kind!='provider' AND completed=0
        ORDER BY "threadId",reason LIMIT 1`;
        let blocker = busy[0];
        const sessions = yield* sql<{
          threadId: string;
          status: string | null;
          activeTurnId: string | null;
          runtimeTurnId: string | null;
        }>`
          SELECT t.thread_id AS "threadId",s.status,s.active_turn_id AS "activeTurnId",json_extract(r.runtime_payload_json,'$.activeTurnId') AS "runtimeTurnId"
          FROM projection_threads t LEFT JOIN projection_thread_sessions s USING(thread_id)
          LEFT JOIN provider_session_runtime r USING(thread_id) WHERE t.thread_id IN ${sql.in(ids)}`;
        const markers = new Set<string>();
        for (const session of sessions) {
          if (session.activeTurnId) markers.add(session.activeTurnId);
          if (session.runtimeTurnId) markers.add(session.runtimeTurnId);
        }
        for (const session of live)
          if (ids.includes(session.threadId) && session.activeTurnId)
            markers.add(session.activeTurnId);
        const settled = markers.size
          ? yield* sql<{ threadId: string; turnId: string }>`
          SELECT thread_id AS "threadId",turn_id AS "turnId" FROM projection_turns
          WHERE thread_id IN ${sql.in(ids)} AND turn_id IN ${sql.in([...markers])} AND completed_at IS NOT NULL
            AND state NOT IN ('pending','running') AND checkpoint_status IN ('ready','skipped','error')
          UNION SELECT thread_id AS "threadId",turn_id AS "turnId" FROM checkout_work_admissions
          WHERE thread_id IN ${sql.in(ids)} AND turn_id IN ${sql.in([...markers])} AND turn_finalized=1`
          : [];
        const finalized = new Set(settled.map((row) => JSON.stringify([row.threadId, row.turnId])));
        const isFinalized = (threadId: string, turnId: string) =>
          finalized.has(JSON.stringify([threadId, turnId]));
        for (const session of sessions) {
          if (blocker) break;
          if (session.status === "starting")
            blocker = { threadId: session.threadId, reason: "finish starting its provider" };
          else if (
            [session.activeTurnId, session.runtimeTurnId].some(
              (turnId) => turnId !== null && !isFinalized(session.threadId, turnId),
            )
          )
            blocker = { threadId: session.threadId, reason: "confirm its native turn has settled" };
        }
        for (const session of live) {
          if (blocker) break;
          if (
            ids.includes(session.threadId) &&
            (session.status === "running" ||
              session.status === "connecting" ||
              (session.activeTurnId !== undefined &&
                !isFinalized(session.threadId, session.activeTurnId)))
          )
            blocker = {
              threadId: session.threadId,
              reason:
                session.status === "connecting"
                  ? "finish connecting its provider"
                  : "finish its provider turn",
            };
        }
        const queues = yield* sql<{
          threadId: string;
          state: string;
        }>`SELECT thread_id AS "threadId",state_json AS state FROM projection_thread_prompt_queues WHERE thread_id IN ${sql.in(ids)} ORDER BY thread_id`;
        for (const row of queues) {
          if (blocker) break;
          const queue = yield* decodeQueue(row.state);
          if (queue.handoff)
            blocker = { threadId: row.threadId, reason: "finish delivering its queued prompt" };
          else if (queue.awaitingTurnId)
            blocker = { threadId: row.threadId, reason: "finish its turn and checkpoint" };
          else if (
            queue.preparation?.state === "running" ||
            (queue.preparation?.state === "failed" && !queue.preparation.settled)
          )
            blocker = { threadId: row.threadId, reason: "confirm its setup has stopped" };
        }
        for (const threadId of ids) {
          if (blocker) break;
          const liveness = background.getThreadBackgroundLiveness(threadId);
          if (liveness)
            blocker = {
              threadId,
              reason:
                liveness === "monitoring"
                  ? "stop its background monitor"
                  : "finish its background work",
            };
        }
        if (!blocker) {
          const [admitted] = yield* captures.blockers(prepared);
          if (admitted)
            blocker = {
              threadId: admitted.threadId,
              reason:
                admitted.kind === "terminal"
                  ? "confirm its terminal has stopped"
                  : admitted.kind === "setup"
                    ? "confirm its setup has stopped"
                    : admitted.kind === "provider"
                      ? "acknowledge its provider request and finish checkpointing"
                      : "finish its workspace operation",
            };
        }
        if (blocker) {
          const [thread] = yield* sql<{
            title: string;
          }>`SELECT title FROM projection_threads WHERE thread_id=${blocker.threadId}`;
          return yield* new CheckoutCaptureError({
            message: `Waiting for "${thread?.title ?? blocker.threadId}" to ${blocker.reason}.`,
            waitingForCheckout: true,
          });
        }
        return yield* captures.enterCapturing(owner);
      }),
    );
  });
  const finish = Effect.fnUntraced(function* (
    owner: ThreadMoveOwner,
    outcome: "completed" | "cancelled",
  ) {
    const state = yield* readQueue(owner.threadId),
      head = state?.queue.entries[0];
    if (!head || head.kind !== "move" || head.operationId !== owner.operationId) return;
    if (outcome === "cancelled" && head.state !== "cancelling") return;
    yield* engine.dispatch({
      type: "thread.move.finish",
      threadId: ThreadId.make(owner.threadId),
      commandId: CommandId.make(`${owner.operationId}:finish:${outcome}:${head.revision}`),
      messageId: head.messageId,
      operationId: CommandId.make(owner.operationId),
      expectedRevision: head.revision,
      outcome,
      createdAt: yield* now,
    });
  });
  const reportFailure = Effect.fnUntraced(function* (
    owner: ThreadMoveOwner,
    error: unknown,
    side: "source" | "destination",
  ) {
    const detail = failureDetail(error);
    const move = yield* transport.get(owner);
    yield* assertThreadMoveIdentity(owner, move);
    if (
      !["preparing", "frozen", "ready"].includes(move.phase) ||
      owner.environmentId !==
        (side === "source" ? move.sourceEnvironmentId : move.destinationEnvironmentId)
    )
      return;
    const reported = yield* transport.failed(owner, detail);
    yield* assertThreadMoveIdentity(owner, reported);
  });
  const source = Effect.fn("ThreadMoveWorker.source")(function* (threadId: string) {
    const state = yield* readQueue(threadId);
    let fence = yield* fences.get(threadId);
    if (!state || !fence || fence.phase === "retired") return;
    let head = state.queue.entries[0];
    if (!head || head.kind !== "move") return;
    yield* assertWorkflowThreadReleased(sql, threadId).pipe(
      Effect.mapError((error) => fail(threadId, error.message)),
    );
    if (head.state === "pending") {
      if (
        !state.queue.enabled ||
        state.archivedAt !== null ||
        state.queue.handoff ||
        state.queue.awaitingTurnId ||
        (state.queue.preparation &&
          (!state.queue.preparation.settled || state.queue.preparation.state !== "ready"))
      )
        return;
      const unsettled = yield* sql`SELECT 1 FROM projection_turns WHERE thread_id=${threadId}
        AND (completed_at IS NULL OR state IN ('pending','running') OR checkpoint_status='pending')
        UNION ALL SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId}
          AND (kind='workspace' OR (${!tracked} AND kind!='provider') OR completed=1)
          AND (completed=0 OR relay_completed=0) LIMIT 1`;
      if (unsettled.length) {
        const localProcesses = !tracked
          ? yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId}
              AND kind IN ('terminal','setup') AND completed=0 LIMIT 1`
          : [];
        const detail =
          "This thread has local terminal or setup work that Launchpad cannot confirm has stopped. The move will stay queued. Cancel it to continue here.";
        if (localProcesses.length && head.detail !== detail)
          yield* engine.dispatch({
            type: "thread.move.progress",
            threadId: ThreadId.make(threadId),
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            messageId: head.messageId,
            expectedRevision: head.revision,
            blocked: true,
            detail,
            createdAt: yield* now,
          });
        return;
      }
      if ((yield* registry.getInstance(state.model.instanceId))?.driverKind !== "codex")
        return yield* fail(threadId, "VM moves currently require Codex.");
      yield* engine.dispatch({
        type: "thread.move.claim",
        threadId: ThreadId.make(threadId),
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        messageId: head.messageId,
        expectedRevision: head.revision,
        expectedControlRevision: state.queue.revision,
        createdAt: yield* now,
      });
      head = (yield* readQueue(threadId))?.queue.entries[0];
    }
    if (!head || head.kind !== "move" || !head.operationId) return;
    const owner = { ...fence, operationId: head.operationId };
    const claimed = head;
    const sourceFence = fence;
    return yield* Effect.gen(function* () {
      const head = claimed;
      let fence = sourceFence;
      let move;
      if (fence.phase === "active" && fence.operationId !== owner.operationId) {
        const actorUserId = (head.editedBy ?? head.author)?.userId;
        if (!actorUserId)
          return yield* fail(threadId, "Sign in before moving this private thread.");
        if (head.destination.kind === "vm") {
          const result = yield* transport.beginVm(owner, {
            actorUserId,
            cancelBeforeStart: head.state === "cancelling",
          });
          if (result.status === "quota_reached") {
            const detail =
              result.replacement?.phase === "cancelled"
                ? "VM replacement was cancelled. Cancel this move to continue here."
                : result.replacement?.phase === "waiting"
                  ? "Saving the selected VM. This move will continue after its slot is safely released."
                  : `VM limit reached (${result.reservedVms}/${result.maxVms}). Select an idle VM to replace before this move can continue.`;
            if (head.detail !== detail)
              yield* engine.dispatch({
                type: "thread.move.progress",
                threadId: ThreadId.make(threadId),
                commandId: CommandId.make(`${owner.operationId}:quota:${head.revision}`),
                messageId: head.messageId,
                operationId: CommandId.make(owner.operationId),
                expectedRevision: head.revision,
                blocked: true,
                detail,
                createdAt: yield* now,
              });
            return;
          }
          move = result.move;
        } else
          move = yield* transport.begin(owner, {
            actorUserId,
            destinationEnvironmentId: head.destination.environmentId,
            destinationProjectId: head.destination.projectId,
          });
      } else move = yield* transport.get(owner);
      yield* assertThreadMoveIdentity(owner, move);
      if (
        head.destination.kind === "environment" &&
        (move.destinationEnvironmentId !== head.destination.environmentId ||
          move.destinationProjectId !== head.destination.projectId)
      )
        return yield* fail(
          threadId,
          "The relay returned a different destination for the queued move.",
        );
      if (fence.phase === "active" && fence.operationId !== owner.operationId) {
        yield* fences.beginDrain({ ...owner, previousOperationId: fence.operationId });
        fence = (yield* fences.get(threadId))!;
      }
      if (move.sourceEnvironmentId !== owner.environmentId) return;
      if (["committed", "completed"].includes(move.phase)) {
        if (fence.phase !== "retired") yield* fences.retire(owner);
        return;
      }
      if (head.state === "cancelling" && !["aborting", "aborted"].includes(move.phase)) {
        yield* releaseCapture(owner, "cancelled");
        move = yield* transport.abort(owner);
        yield* assertThreadMoveIdentity(owner, move);
      }
      if (move.phase === "aborting") {
        yield* releaseCapture(owner, "cancelled");
        return;
      }
      if (move.phase === "aborted") {
        yield* releaseCapture(owner, "cancelled");
        const held = yield* captures.get(owner.operationId);
        if (held?.phase === "capturing") return;
        if (tracked) {
          const inventory = yield* inspectVmWorkloads({ type: "inspect" });
          if (inventory.sealedBy !== null)
            yield* inspectVmWorkloads({
              type: "reopen",
              bootId: inventory.bootId,
              operationId: owner.operationId,
            });
        }
        yield* fences.activate(owner);
        yield* commands.synchronize(threadId);
        yield* finish(owner, "cancelled");
        return;
      }
      // Repair the exact saved archive even when a failed commit left a retained error.
      if (move.manifestArtifactId !== null && move.recoveryVerified !== true) {
        const receipt = yield* transport.publish(owner, move.manifestArtifactId);
        if (receipt.manifestArtifactId !== move.manifestArtifactId)
          return yield* fail(threadId, "The recovery receipt belongs to another move archive.");
      }
      // Failure details live in relay placement state. Appending local queue
      // events here would invalidate the immutable source sequence being moved.
      if (move.failureDetail && move.phase !== "preparing") return;
      if (move.phase === "ready") {
        const committed = yield* transport.commit(owner);
        yield* assertThreadMoveIdentity(owner, committed);
        if (!["committed", "completed"].includes(committed.phase))
          return yield* fail(threadId, "Ownership has not been committed.");
        yield* fences.retire(owner);
        return;
      }
      const priorCapture = yield* captures.get(owner.operationId);
      const sealedSha256 =
        priorCapture?.releaseOutcome === "sealed" ? priorCapture.manifestSha256! : undefined;
      const prepared =
        sealedSha256 === undefined
          ? yield* prepareCapture(owner).pipe(
              Effect.tapError((error) => reportFailure(owner, error, "source").pipe(Effect.ignore)),
            )
          : null;
      if (prepared) {
        const admitted = yield* captures.acquireDrain({ ...owner, ...prepared }).pipe(
          Effect.as(true),
          Effect.catchTag(
            "CheckoutCaptureError",
            Effect.fnUntraced(function* (error) {
              if (!error.waitingForCheckout) return yield* error;
              yield* checkoutNotice(owner, true, error.message);
              return false;
            }),
          ),
        );
        if (!admitted) return;
      }
      const [runtime] = yield* sql<{
        status: string;
      }>`SELECT status FROM provider_session_runtime WHERE thread_id=${threadId}`;
      const providerWork =
        yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId}
      AND generation=${owner.generation} AND kind='provider' AND completed=0 LIMIT 1`;
      if (
        providerWork.length ||
        (runtime && runtime.status !== "stopped") ||
        (yield* provider.listSessions()).some((session) => session.threadId === threadId)
      )
        yield* provider.stopSession({ threadId: ThreadId.make(threadId) });
      if (runtime || providerWork.length) {
        if (!provider.flushRuntimeEvents)
          return yield* fail(threadId, "Stopped provider output has not been confirmed.");
        yield* provider.flushRuntimeEvents(ThreadId.make(threadId));
        const [session] =
          yield* sql`SELECT thread_id AS "threadId",status,provider_name AS "providerName",provider_instance_id AS "providerInstanceId",
        runtime_mode AS "runtimeMode",active_turn_id AS "activeTurnId",last_error AS "lastError",updated_at AS "updatedAt"
        FROM projection_thread_sessions WHERE thread_id=${threadId}`;
        if (session && session.status !== "stopped")
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`${owner.operationId}:source-stopped`),
            threadId: ThreadId.make(threadId),
            createdAt: yield* now,
            session: yield* decodeSession({
              ...session,
              status: "stopped",
              activeTurnId: null,
              lastError: null,
              updatedAt: yield* now,
            }),
          });
      }
      yield* terminals.close({ threadId: ThreadId.make(threadId), waitForProcessExit: true });
      if (tracked) {
        const inventory = yield* inspectVmWorkloads({ type: "inspect" });
        const stopped = yield* inspectVmWorkloads({
          type: "stop",
          bootId: inventory.bootId,
          operationId: owner.operationId,
        });
        if (!stopped.stopped) return;
      }
      yield* execution.confirmProcessesStopped(threadId, tracked ? "vm" : "provider");
      const progress = makeThreadMoveProgress(move.progress ?? [], owner.environmentId, (report) =>
        transport.progress(owner, report),
      );
      if (move.manifestArtifactId === null) yield* progress.stage("capturing");
      if (prepared) {
        const ready = yield* enterCapture(owner, prepared).pipe(
          Effect.as(true),
          Effect.catchTag(
            "CheckoutCaptureError",
            Effect.fnUntraced(function* (error) {
              if (!error.waitingForCheckout) return yield* error;
              yield* checkoutNotice(owner, true, error.message);
              return false;
            }),
          ),
        );
        if (!ready) return;
      }
      yield* checkoutNotice(owner, false, "Preparing the source snapshot.");
      const saved = yield* Effect.gen(function* () {
        const saved = yield* sourceArchive(owner, sealedSha256);
        // Reused archives must still match the exact frozen placement and event head.
        yield* verifySourceOwner(owner, saved);
        const hold = yield* captures.release(owner, {
          outcome: "sealed",
          manifestSha256: saved.sha256,
        });
        yield* notifyCheckoutCaptureReleased(sql, hold.checkoutRoot);
        return saved;
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const hold = yield* captures.get(owner.operationId);
            // A typed local failure arrives only after the copy's child work settled.
            // Interruption deliberately retains the hold for recovery.
            if (hold?.phase === "capturing") {
              yield* captures.release(owner, { outcome: "failed", expectedPhase: "capturing" });
              yield* notifyCheckoutCaptureReleased(sql, hold.checkoutRoot);
            }
            yield* reportFailure(owner, error, "source").pipe(Effect.ignore);
          }),
        ),
      );
      yield* history.synchronize(threadId);
      if (move.phase === "preparing") {
        move = yield* transport.freeze(owner, {
          sourceCursor: saved.manifest.history.sourceSequence,
          manifestSha256: saved.sha256,
        });
        yield* assertThreadMoveIdentity(owner, move);
      }
      if (
        move.manifestSha256 !== saved.sha256 ||
        move.sourceCursor !== saved.manifest.history.sourceSequence
      )
        return yield* fail(threadId, "The frozen source changed after the move began.");
      // Publication verifies every artifact. Keep the source frozen while the destination imports it.
      if (move.manifestArtifactId !== null) return;
      yield* progress.stage("packing");
      const packed = yield* packThreadTransferArchive({
        archiveDirectory: saved.directory,
        scratchRoot: path.join(root, "chunks"),
        expectedManifestSha256: saved.sha256,
      });
      yield* Effect.gen(function* () {
        yield* progress.stage("uploading", {
          bytes: packed.uploads.reduce((sum, file) => sum + file.sizeBytes, 0),
          artifacts: packed.uploads.length,
        });
        yield* Effect.forEach(
          packed.uploads,
          Effect.fnUntraced(function* (file) {
            const expected = {
              artifactId: file.artifactId,
              operationId: owner.operationId,
              kind: file.kind,
              sha256: file.sha256,
              sizeBytes: file.sizeBytes,
            };
            const receipt = yield* transport.upload(owner, expected, fs.stream(file.path));
            if (
              receipt.threadId !== threadId ||
              receipt.artifactId !== expected.artifactId ||
              receipt.operationId !== owner.operationId ||
              receipt.sha256 !== expected.sha256 ||
              receipt.kind !== expected.kind ||
              receipt.sizeBytes !== expected.sizeBytes ||
              receipt.state !== "complete"
            )
              return yield* fail(
                threadId,
                "The move upload receipt does not match its saved bytes.",
              );
            yield* progress.verified(file.artifactId, file.sizeBytes);
          }),
          { concurrency: 4, discard: true },
        );
        const receipt = yield* transport.publish(owner, packed.artifactId);
        if (
          receipt.manifestArtifactId !== packed.artifactId ||
          receipt.artifactCount !== packed.uploads.length
        )
          return yield* fail(threadId, "The relay did not verify this complete move archive.");
      }).pipe(
        Effect.ensuring(fs.remove(packed.directory, { recursive: true }).pipe(Effect.ignore)),
      );
    }).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          const hold = yield* captures.get(owner.operationId);
          if (hold?.phase === "draining") yield* releaseCapture(owner, "failed");
        }).pipe(Effect.ignore),
      ),
    );
  });
  const destinationArchive = Effect.fnUntraced(function* (
    owner: ThreadMoveOwner,
    manifestArtifactId: string,
    expectedSha256: string,
    progress: ReturnType<typeof makeThreadMoveProgress>,
  ) {
    const target = operationPath(owner, "destination");
    if (yield* fs.exists(target)) {
      const saved = yield* inspectArchive(owner, target);
      if (saved.sha256 !== expectedSha256)
        return yield* fail(owner.threadId, "The received move archive changed.");
      return saved;
    }
    yield* fs.makeDirectory(path.join(root, "downloads"), { recursive: true, mode: 0o700 });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: path.join(root, "downloads"),
          prefix: "receive-",
        });
        const manifestBody = yield* transport.artifact(owner, manifestArtifactId);
        let manifestBytes = 0;
        const parts = yield* manifestBody.pipe(
          Stream.mapEffect((part) => {
            manifestBytes += part.length;
            return manifestBytes > 32 * 1024 * 1024
              ? Effect.fail(fail(owner.threadId, "The move index is too large."))
              : Effect.succeed(part);
          }),
          Stream.runCollect,
        );
        const bytes = new Uint8Array(manifestBytes);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const manifest = yield* decodeChunks(new TextDecoder().decode(bytes));
        if (
          manifest.threadId !== owner.threadId ||
          manifest.operationId !== owner.operationId ||
          manifest.generation + 1 !== owner.generation ||
          manifest.transferManifestSha256 !== expectedSha256 ||
          manifest.files.length > 100_000 ||
          manifest.files.reduce((total, file) => total + file.sizeBytes, 0) > 64 * 1024 ** 3
        )
          return yield* fail(
            owner.threadId,
            "The move index belongs to another placement or exceeds its limit.",
          );
        const ids = new Set<string>();
        for (const file of manifest.files)
          for (const chunk of file.chunks) {
            if (
              ids.has(chunk.artifactId) ||
              ids.size >= 100_000 ||
              chunk.sizeBytes > 64 * 1024 * 1024
            )
              return yield* fail(owner.threadId, "The move index has invalid or repeated chunks.");
            ids.add(chunk.artifactId);
          }
        const chunks = manifest.files.flatMap((file) => file.chunks);
        yield* progress.stage("downloading", {
          bytes: chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0),
          artifacts: chunks.length,
        });
        yield* Effect.forEach(
          chunks,
          Effect.fnUntraced(function* (chunk) {
            const digest = NodeCrypto.createHash("sha256");
            let written = 0;
            const body = yield* transport.artifact(owner, chunk.artifactId);
            yield* Effect.scoped(
              Effect.gen(function* () {
                const output = yield* fs.open(path.join(staging, chunk.artifactId), {
                  flag: "wx",
                  mode: 0o600,
                });
                yield* body.pipe(
                  Stream.runForEach((part) =>
                    Effect.gen(function* () {
                      written += part.length;
                      if (written > chunk.sizeBytes)
                        return yield* fail(
                          owner.threadId,
                          "A move chunk exceeds its immutable size.",
                        );
                      digest.update(part);
                      yield* output.writeAll(part);
                    }),
                  ),
                  Effect.timeout(THREAD_MOVE_ARTIFACT_TIMEOUT),
                );
                yield* output.sync;
              }),
            );
            if (written !== chunk.sizeBytes || digest.digest("hex") !== chunk.sha256)
              return yield* fail(owner.threadId, "A move chunk failed verification.");
            yield* progress.verified(chunk.artifactId, written);
          }),
          { concurrency: 4, discard: true },
        );
        const directory = yield* materializeThreadTransferChunks({
          manifest,
          chunkDirectory: staging,
          destinationRoot: path.join(root, "staging"),
          threadId: owner.threadId,
          operationId: owner.operationId,
          transferManifestSha256: expectedSha256,
        });
        yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
        yield* fs.rename(directory, target);
        yield* Effect.scoped(
          fs
            .open(path.dirname(target), { flag: "r" })
            .pipe(Effect.flatMap((handle) => handle.sync)),
        );
        return yield* inspectArchive(owner, target);
      }),
    );
  });
  const rollbackDestination = Effect.fn("ThreadMoveWorker.rollbackDestination")(function* (
    owner: ThreadMoveOwner,
    move: import("@t3tools/contracts/relay").RelayThreadMove,
  ) {
    // A guest cannot attest deletion of its own compute. The host coordinator
    // owns VM cancellation; ordinary environments can attest local rollback.
    if (tracked)
      return yield* fail(owner.threadId, "Waiting for the VM host to confirm destination removal.");
    const fence = yield* fences.get(owner.threadId);
    const claim = yield* claims.get(owner.operationId);
    if (
      fence?.operationId === owner.operationId &&
      fence.phase !== "frozen" &&
      fence.phase !== "retired"
    )
      return yield* fail(owner.threadId, "Destination work is not fenced for cancellation.");
    if (claim && (claim.phase !== "released" || claim.releaseReason !== "cancelled")) {
      if (!move.manifestSha256)
        return yield* fail(owner.threadId, "Destination rollback is missing its recovery archive.");
      const saved = yield* inspectArchive(owner, operationPath(owner, "destination"));
      if (saved.sha256 !== move.manifestSha256)
        return yield* fail(owner.threadId, "Destination rollback archive changed.");
      yield* makeThreadCheckoutInstaller(sql)
        .rollback({
          ...owner,
          projectId: move.destinationProjectId,
          manifestSha256: saved.sha256,
          workspace: saved.manifest.workspace,
          stagedWorkspaceRoot: saved.directory,
          worktreesRoot: config.worktreesDir,
          recoveryRoot: path.join(root, "recovery"),
        })
        .pipe(Effect.provideContext(context));
    }
    const aborted = move.phase === "aborted" ? move : yield* transport.removed(owner);
    yield* assertThreadMoveIdentity(owner, aborted);
    yield* makeThreadTransferAborts(sql).record(owner, aborted);
  });
  const destination = Effect.fn("ThreadMoveWorker.destination")(function* (owner: ThreadMoveOwner) {
    const move = yield* transport.get(owner);
    yield* assertThreadMoveIdentity(owner, move);
    if (owner.environmentId !== move.destinationEnvironmentId) return;
    const previous = yield* fences.get(owner.threadId);
    if (move.phase === "completed") {
      if (previous?.operationId === owner.operationId && previous.phase === "frozen") {
        if (tracked) {
          const claim = yield* claims.get(owner.operationId);
          if (!claim || claim.phase !== "installed")
            return yield* fail(owner.threadId, "The completed move is missing its checkout claim.");
          yield* configureThreadVmMoveRepository(owner, claim.checkoutPath).pipe(
            Effect.provideContext(context),
          );
        }
        yield* fences.activate(owner);
      }
      if (previous?.operationId === owner.operationId) yield* finish(owner, "completed");
      return;
    }
    if (move.phase === "preparing") return;
    if (move.phase === "aborting" || move.phase === "aborted")
      return yield* rollbackDestination(owner, move);
    if (move.failureDetail) {
      const started = yield* sql`SELECT 1 FROM thread_transfer_readiness
        WHERE operation_id=${owner.operationId} AND phase='started' LIMIT 1`;
      if (started.length) return;
    }
    const validateProject = Effect.gen(function* () {
      // Installation retries verify the durable claim and readiness; mutable
      // remotes or relay aliases must not strand an already installed checkout.
      if (tracked || (yield* claims.get(owner.operationId))?.phase === "installed") return;
      const [project] = yield* sql<{ root: string }>`SELECT workspace_root AS root
        FROM projection_projects WHERE project_id=${move.destinationProjectId} AND deleted_at IS NULL`;
      if (!project) return yield* fail(owner.threadId, "The destination project no longer exists.");
      const projectRoot = yield* fs.realPath(project.root);
      if (
        (yield* fs.realPath(
          yield* workspaceGitText(projectRoot, ["rev-parse", "--show-toplevel"]).pipe(
            Effect.provideContext(context),
          ),
        )) !== projectRoot
      )
        return yield* fail(
          owner.threadId,
          "The destination project must point to a Git checkout root.",
        );
      const repository = yield* repositories.resolve(projectRoot, { refresh: true });
      if (!move.repositoryCanonicalKeys?.length)
        return yield* fail(owner.threadId, "The relay did not confirm the transferred repository.");
      if (!repository || !move.repositoryCanonicalKeys.includes(repository.canonicalKey))
        return yield* fail(
          owner.threadId,
          "The destination project no longer matches the transferred repository. Its local files were left untouched.",
        );
    });
    yield* validateProject;
    if (!move.manifestArtifactId || !move.manifestSha256 || move.sourceCursor === null) return;
    const progress = makeThreadMoveProgress(move.progress ?? [], owner.environmentId, (report) =>
      transport.progress(owner, report),
    );
    yield* progress.stage("downloading");
    const saved = yield* destinationArchive(
      owner,
      move.manifestArtifactId,
      move.manifestSha256,
      progress,
    );
    if (
      saved.manifest.history.environmentId !== move.sourceEnvironmentId ||
      saved.manifest.history.sourceSequence !== move.sourceCursor
    )
      return yield* fail(owner.threadId, "The destination archive has a different frozen source.");
    if (!tracked) yield* fences.prepare({ ...owner, projectId: move.destinationProjectId });
    yield* progress.stage("installing");
    const selected = yield* stageThreadTransferArchive({
      owner: { ...saved.manifest.history },
      expectedSha256: saved.sha256,
      artifactDirectory: saved.directory,
      destinationRoot: path.join(root, "validation"),
      codexVersion: CODEX_CONVERSATION_TRANSFER_VERSION,
    }).pipe(Effect.provideContext(context));
    let model: ModelSelection | undefined;
    yield* selected.history.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (
            (event.type === "thread.created" || event.type === "thread.meta-updated") &&
            event.payload.modelSelection
          )
            model = event.payload.modelSelection;
        }),
      ),
      Effect.ensuring(fs.remove(selected.directory, { recursive: true }).pipe(Effect.ignore)),
    );
    if (!model || (yield* registry.getInstance(model.instanceId))?.driverKind !== "codex")
      return yield* fail(
        owner.threadId,
        "The moved thread does not have a supported Codex instance.",
      );
    const freshCheckoutRoot = tracked
      ? yield* prepareThreadVmMoveWorkspace(owner, move.destinationProjectId).pipe(
          Effect.provideContext(context),
        )
      : undefined;
    if (tracked) yield* fences.prepare({ ...owner, projectId: move.destinationProjectId });
    yield* validateProject;
    const claim = yield* claims.get(owner.operationId);
    if (claim?.phase === "installing")
      yield* makeThreadCheckoutInstaller(sql)
        .reconcile({
          ...owner,
          projectId: move.destinationProjectId,
          manifestSha256: saved.sha256,
          workspace: saved.manifest.workspace,
          stagedWorkspaceRoot: saved.directory,
          worktreesRoot: config.worktreesDir,
        })
        .pipe(Effect.provideContext(context));
    yield* installThreadTransferArchive({
      source: saved.manifest.history,
      destination: { ...owner, projectId: move.destinationProjectId },
      manifestSha256: saved.sha256,
      artifactDirectory: saved.directory,
      recoveryRoot: path.join(root, "recovery"),
      worktreesRoot: config.worktreesDir,
      stateDir: config.stateDir,
      attachmentsDir: config.attachmentsDir,
      providerInstanceId: model.instanceId,
      codexVersion: CODEX_CONVERSATION_TRANSFER_VERSION,
      importedAt: yield* now,
      ...(freshCheckoutRoot ? { freshCheckoutRoot } : {}),
    }).pipe(Effect.provideContext(context));
    if (freshCheckoutRoot)
      yield* configureThreadVmMoveRepository(owner, freshCheckoutRoot).pipe(
        Effect.provideContext(context),
      );
    yield* progress.stage("setup");
    yield* prepareThreadTransfer({
      ...owner,
      threadId: ThreadId.make(owner.threadId),
      manifestSha256: saved.sha256,
    }).pipe(Effect.provideContext(context));
    yield* progress.stage("activating");
    if (move.phase === "frozen" || move.phase === "ready") {
      const ready = yield* transport.ready(owner, {
        sourceCursor: move.sourceCursor,
        manifestSha256: saved.sha256,
      });
      yield* assertThreadMoveIdentity(owner, ready);
      // A failed commit would hide the missing save behind another retained error.
      if (ready.recoveryVerified !== true) return;
    }
    const committed = yield* transport.commit(owner);
    yield* assertThreadMoveIdentity(owner, committed);
    if (!["committed", "completed"].includes(committed.phase))
      return yield* fail(owner.threadId, "The relay has not committed destination ownership.");
    const activated = yield* transport.activate(owner);
    yield* assertThreadMoveIdentity(owner, activated);
    if (activated.phase !== "completed")
      return yield* fail(owner.threadId, "The relay has not confirmed destination activation.");
    yield* fences.activate(owner);
    yield* finish(owner, "completed");
  });
  return {
    source,
    destination: (owner: ThreadMoveOwner) =>
      destination(owner).pipe(
        Effect.tapError((error) => reportFailure(owner, error, "destination").pipe(Effect.ignore)),
      ),
  };
});
