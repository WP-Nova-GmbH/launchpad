import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  ThreadVmRestoreBoot,
  RelayThreadVmRestoreRecovery,
  RelayThreadVmRestoreImportReceipt,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { installPortableCodexHome } from "../provider/Drivers/PortableCodexHome.ts";
import { CODEX_CONVERSATION_TRANSFER_VERSION } from "../provider/Drivers/CodexConversationTransfer.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { downloadThreadArtifactChunks } from "./ThreadArtifactDownload.ts";
import { materializeNativeCheckpoint } from "./ThreadNativeCheckpointTransfer.ts";
import { materializeAttachmentCheckpoint } from "./ThreadAttachmentCheckpointTransfer.ts";
import { collectThreadAttachmentReferences } from "./ThreadAttachmentReferences.ts";
import { installThreadAttachments } from "./ThreadAttachmentTransfer.ts";
import {
  exportThreadVmRestoreHistory,
  readThreadVmRestoreWorkspace,
} from "./ThreadVmRestoreHistory.ts";
import { materializeThreadVmIndependentHistory } from "./ThreadVmIndependentHistory.ts";
import { inspectThreadHistoryArchive } from "./ThreadHistoryArchive.ts";
import { prepareThreadVmWorkspace } from "./ThreadVmWorkspace.ts";
import { downloadThreadVmRepositoryUpload } from "./ThreadVmRepositoryUpload.ts";
import { adoptThreadVmRestoreCheckout } from "./ThreadVmRestoreCheckout.ts";
import { ThreadHistoryBaselineImporter } from "./ThreadHistoryBaseline.ts";

export const THREAD_VM_RESTORE_STATE_SECRET = "thread-vm-restore-state";
export const ThreadVmRestoreState = Schema.Struct({
  recovery: RelayThreadVmRestoreRecovery,
  receipt: RelayThreadVmRestoreImportReceipt,
  phase: Schema.Literals(["installed", "ready", "activated"]),
});
export type ThreadVmRestoreState = typeof ThreadVmRestoreState.Type;
const decodeRecovery = Schema.decodeEffect(RelayThreadVmRestoreRecovery);
const decodeState = Schema.decodeEffect(Schema.fromJsonString(ThreadVmRestoreState));
export const encodeThreadVmRestoreState = Schema.encodeEffect(
  Schema.fromJsonString(ThreadVmRestoreState),
);
const encodeRecovery = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmRestoreRecovery));
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export class ThreadVmRestoreInstallError extends Schema.TaggedError<ThreadVmRestoreInstallError>()(
  "ThreadVmRestoreInstallError",
  {},
) {
  override get message() {
    return "Saved conversation installation is unconfirmed. VM execution remains blocked.";
  }
}
const fail = () => new ThreadVmRestoreInstallError();
export const readThreadVmRestoreState = Effect.fn("ThreadVmRestoreInstall.read_state")(
  function* () {
    const raw = yield* (yield* ServerSecretStore).get(THREAD_VM_RESTORE_STATE_SECRET);
    return Option.isSome(raw) ? yield* decodeState(new TextDecoder().decode(raw.value)) : null;
  },
  Effect.mapError(fail),
);

/** Offline fresh guest only. Restore pinned native/chat artifacts and one saved
 * history baseline without adopting old identity, credentials or global SQL state.
 * Does not run project setup, activate ownership, or release the relay queue. */
export const installThreadVmRestoreRecovery = Effect.fn("ThreadVmRestoreInstall.install")(
  function* <E, R>(input: {
    recovery: RelayThreadVmRestoreRecovery;
    readArtifact: (id: string) => Effect.Effect<Stream.Stream<Uint8Array, E, R>, E, R>;
    workspaceRoot?: string;
  }) {
    const recovery = yield* decodeRecovery(input.recovery),
      vm = yield* readInstalledThreadVm();
    const sql = yield* SqlClient.SqlClient,
      config = yield* ServerConfig,
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const point = recovery.native,
      chat = recovery.attachments;
    const independent = recovery.independentHistory;
    if (
      !vm ||
      vm.environmentId !== environmentId ||
      recovery.environmentId !== environmentId ||
      vm.operationId !== recovery.operationId ||
      vm.scope.allocationId !== recovery.scope.allocationId ||
      vm.scope.threadId !== recovery.scope.threadId ||
      vm.scope.repositoryId !== recovery.scope.repositoryId ||
      vm.scope.generation !== recovery.scope.generation ||
      point.threadId !== vm.scope.threadId ||
      chat.threadId !== point.threadId ||
      (independent
        ? point.generation >= vm.scope.generation
        : point.generation + 1 !== vm.scope.generation) ||
      chat.generation !== point.generation ||
      chat.sourceEnvironmentId !== point.sourceEnvironmentId ||
      point.sourceEnvironmentId === environmentId ||
      chat.sourceSequence !== point.sourceSequence ||
      chat.nativeArchiveSha256 !== point.archiveSha256 ||
      (!independent && !point.captureOperationId) ||
      chat.captureOperationId !== point.captureOperationId ||
      chat.turnId !== point.turnId
    )
      return yield* fail();
    if (
      independent &&
      (independent.nativeBoundary.checkpointOperationId !== point.operationId ||
        independent.nativeBoundary.sourceEnvironmentId !== point.sourceEnvironmentId ||
        independent.nativeBoundary.generation !== point.generation ||
        independent.nativeBoundary.sourceSequence !== point.sourceSequence)
    )
      return yield* fail();
    const workspaceRoot = input.workspaceRoot ?? "/workspace/project",
      projectId = ProjectId.make(`vm:${vm.scope.threadId}`);
    const owner = {
      threadId: vm.scope.threadId,
      operationId: vm.operationId,
      generation: vm.scope.generation,
      projectId,
      environmentId,
      relayUrl: vm.relayUrl,
    };
    const fences = makeThreadExecutionFence(sql);
    const assertFrozen = Effect.gen(function* () {
      const current = yield* fences.get(owner.threadId);
      if (
        !current ||
        current.phase !== "frozen" ||
        current.operationId !== owner.operationId ||
        current.environmentId !== environmentId ||
        current.projectId !== projectId ||
        current.generation !== owner.generation ||
        current.relayUrl !== owner.relayUrl
      )
        return yield* fail();
    });
    const prior = yield* readThreadVmRestoreState();
    if (prior) {
      if (
        (yield* encodeRecovery(prior.recovery)) !== (yield* encodeRecovery(recovery)) ||
        prior.receipt.workspaceRoot !== workspaceRoot
      )
        return yield* fail();
      yield* assertFrozen;
      return prior.receipt;
    }
    const unrelated = yield* sql`SELECT 1 FROM projection_projects WHERE project_id!=${projectId}
      UNION ALL SELECT 1 FROM projection_threads WHERE thread_id!=${owner.threadId}
      UNION ALL SELECT 1 FROM thread_execution_work WHERE completed=0 OR relay_completed=0 LIMIT 1`;
    if (unrelated.length) return yield* fail();
    if (recovery.reset) {
      const reset = recovery.reset;
      if (
        !point.recoveryHistory ||
        !reset.repositoryUpload ||
        reset.repositoryUpload.threadId !== vm.scope.threadId ||
        reset.repositoryUpload.revision !== reset.revision ||
        (reset.repositoryUpload.branch ?? "main") !== reset.branch
      )
        return yield* fail();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* downloadThreadVmRepositoryUpload({
            repository: reset.repositoryUpload!,
            threadId: vm.scope.threadId,
            scratchRoot: path.join(config.stateDir, "repository-upload-staging"),
            readArtifact: input.readArtifact,
          });
          yield* prepareThreadVmWorkspace(
            {
              operationId: vm.operationId,
              scope: vm.scope,
              canonicalKey: reset.canonicalKey,
              branch: reset.branch,
              revision: reset.revision,
            },
            workspaceRoot,
            "reset",
            repository,
          );
        }),
      );
    }
    if ((yield* fs.realPath(workspaceRoot)) !== workspaceRoot) return yield* fail();
    const scratchRoot = path.join(config.stateDir, "restore-staging");
    yield* fs.makeDirectory(scratchRoot, { recursive: true, mode: 0o700 });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const scratch = yield* fs.makeTempDirectoryScoped({
          directory: scratchRoot,
          prefix: "restore-",
        });
        const savedDisk =
          recovery.reset || independent
            ? null
            : yield* exportThreadVmRestoreHistory({
                boot: {
                  version: 1,
                  operationId: vm.operationId,
                  allocationId: vm.scope.allocationId,
                  threadId: vm.scope.threadId,
                  generation: vm.scope.generation,
                },
                native: point,
                baseDir: config.baseDir,
                workspaceRoot,
                artifactRoot: scratch,
              });
        const index = (receipt: typeof point | typeof chat, maxFiles: number, maxBytes: number) =>
          downloadThreadArtifactChunks({
            ...receipt,
            indexArtifactId: receipt.manifestArtifactId,
            indexSha256: receipt.manifestSha256,
            scratchRoot: scratch,
            maxFiles,
            maxBytes,
            readArtifact: input.readArtifact,
          });
        const nativeChunks = yield* index(point, 1029, 770 * 1024 * 1024);
        const native = yield* materializeNativeCheckpoint({
          ...nativeChunks,
          destinationRoot: scratch,
          threadId: point.threadId,
          operationId: point.operationId,
          transferManifestSha256: nativeChunks.manifest.transferManifestSha256,
          expected: point,
        });
        if (
          native.header.archiveSha256 !== point.archiveSha256 ||
          native.header.nativeManifestSha256 !== point.nativeManifestSha256 ||
          native.header.native.threadId !== point.nativeThreadId
        )
          return yield* fail();
        const chatChunks = yield* index(
          chat,
          THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES + 2,
          THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES + 64 * 1024 * 1024,
        );
        const attachments = yield* materializeAttachmentCheckpoint({
          ...chatChunks,
          destinationRoot: scratch,
          threadId: chat.threadId,
          operationId: chat.operationId,
          transferManifestSha256: chatChunks.manifest.transferManifestSha256,
          expected: chat,
        });
        const retained = native.recoveryHistory;
        if (
          recovery.reset &&
          (!retained ||
            !point.recoveryHistory ||
            retained.manifest.operationId !== point.captureOperationId)
        )
          return yield* fail();
        const history = independent
          ? yield* materializeThreadVmIndependentHistory({
              threadId: owner.threadId,
              operationId: owner.operationId,
              history: independent,
              scratchRoot: scratch,
              readArtifact: input.readArtifact,
            })
          : recovery.reset
            ? retained!
            : yield* inspectThreadHistoryArchive({
                owner: savedDisk!.manifest,
                manifest: savedDisk!.manifest,
                directory: savedDisk!.directory,
              });
        const saved = independent
          ? {
              manifest: history.manifest,
              workspace: yield* readThreadVmRestoreWorkspace({
                boot: {
                  version: 1,
                  operationId: owner.operationId,
                  allocationId: vm.scope.allocationId,
                  threadId: owner.threadId,
                  generation: owner.generation,
                },
                baseDir: config.baseDir,
                workspaceRoot,
              }),
            }
          : recovery.reset
            ? {
                manifest: { ...history.manifest, operationId: vm.operationId },
                workspace: {
                  repositoryRoot: workspaceRoot,
                  checkoutPath: workspaceRoot,
                  branch: recovery.reset.branch,
                },
              }
            : savedDisk!;
        const events = yield* Stream.runCollect(history.events);
        let provider: ProviderInstanceId | undefined;
        for (const event of events)
          if (
            (event.type === "thread.created" || event.type === "thread.meta-updated") &&
            event.payload.modelSelection
          )
            provider = event.payload.modelSelection.instanceId;
        if (provider !== "codex") return yield* fail();
        const manifestSha256 = NodeCrypto.createHash("sha256")
          .update(
            yield* encodeIdentity({
              recovery,
              history: saved.manifest,
              workspace: saved.workspace,
            }),
          )
          .digest("hex");
        const [project] = yield* sql<{
          root: string;
        }>`SELECT workspace_root AS root FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
        if (project && project.root !== workspaceRoot) return yield* fail();
        if (!project)
          yield* (yield* OrchestrationEngineService).dispatch({
            type: "project.create",
            commandId: CommandId.make(`${vm.operationId}:restore-project`),
            projectId,
            title: "VM workspace",
            workspaceRoot,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
        yield* fences.prepare(owner);
        yield* assertFrozen;
        const checkout = yield* adoptThreadVmRestoreCheckout({
          ...owner,
          ...saved.workspace,
          manifestSha256,
          worktreesRoot: config.worktreesDir,
        });
        if (
          recovery.reset &&
          (checkout.branch !== recovery.reset.branch || checkout.head !== recovery.reset.revision)
        )
          return yield* fail();
        const portable = yield* installPortableCodexHome({
          stateDir: config.stateDir,
          threadId: owner.threadId,
          operationId: owner.operationId,
          providerInstanceId: provider,
          transferSha256: manifestSha256,
          manifest: native.header.native,
          rolloutPath: path.join(native.nativeDirectory, "rollout.jsonl"),
          codexVersion: CODEX_CONVERSATION_TRANSFER_VERSION,
        });
        yield* installThreadAttachments({
          threadId: owner.threadId,
          attachments: yield* collectThreadAttachmentReferences(
            owner.threadId,
            Stream.fromIterable(events),
          ),
          manifest: attachments.header.attachments,
          artifactDirectory: attachments.attachmentsDirectory,
          attachmentsDir: config.attachmentsDir,
        });
        const baseline = yield* (yield* ThreadHistoryBaselineImporter).install({
          version: 1,
          manifestSha256,
          source: saved.manifest,
          destination: {
            ...owner,
            branch: checkout.branch,
            worktreePath: checkout.mode === "main" ? null : checkout.checkoutPath,
          },
          events,
          receipts: history.receipts,
          importedAt: DateTime.formatIso(yield* DateTime.now),
          ...(recovery.reset ? { resetVm: true } : {}),
          ...(independent ? { backupRecovery: true } : {}),
          nativeRuntime: { ...portable.resumeCursor, providerInstanceId: provider },
        });
        yield* assertFrozen;
        const receipt: RelayThreadVmRestoreImportReceipt = {
          version: 1,
          operationId: owner.operationId,
          environmentId,
          scope: vm.scope,
          projectId,
          workspaceRoot,
          checkoutPath: checkout.checkoutPath,
          branch: checkout.branch,
          revision: checkout.head,
          manifestSha256,
          sourceEnvironmentId: EnvironmentId.make(point.sourceEnvironmentId),
          sourceSequence: point.sourceSequence,
          nativeManifestArtifactId: point.manifestArtifactId,
          attachmentManifestArtifactId: chat.manifestArtifactId,
          ...(recovery.reset
            ? { repositoryBundleSha256: recovery.reset.repositoryUpload!.bundle.sha256 }
            : {}),
          sequence: baseline.sequence,
          execution: "frozen",
        };
        yield* (yield* ServerSecretStore).create(
          THREAD_VM_RESTORE_STATE_SECRET,
          new TextEncoder().encode(
            yield* encodeThreadVmRestoreState({ recovery, receipt, phase: "installed" }),
          ),
        );
        return receipt;
      }),
    );
  },
  Effect.mapError(fail),
);

/** Relay-selected recovery only; the guest cannot choose a different disk or checkpoint. */
export const importInstalledThreadVmRestore = Effect.fn("ThreadVmRestoreInstall.from_relay")(
  function* (boot: ThreadVmRestoreBoot) {
    const vm = yield* readInstalledThreadVm();
    if (
      !vm ||
      vm.scope.threadId !== boot.threadId ||
      vm.scope.allocationId !== boot.allocationId ||
      vm.scope.generation !== boot.generation ||
      vm.operationId !== boot.operationId
    )
      return yield* fail();
    const client = yield* makeExecutorRelayApiClient({
      url: vm.relayUrl,
      issuer: vm.relayIssuer,
      environmentCredential: vm.environmentCredential,
    });
    const params = { environmentId: vm.environmentId, threadId: ThreadId.make(vm.scope.threadId) };
    const recovery = yield* client.threadEnvironment
      .getRestoreRecovery({ params, payload: { generation: vm.scope.generation } })
      .pipe(Effect.timeout("30 seconds"));
    if (!recovery || recovery.operationId !== boot.operationId) return yield* fail();
    return yield* installThreadVmRestoreRecovery({
      recovery,
      readArtifact: (id) =>
        client.threadEnvironment
          .restoreArtifact({
            params: { ...params, operationId: boot.operationId, artifactId: id },
            query: { generation: vm.scope.generation },
          })
          .pipe(Effect.timeout("30 seconds")),
    });
  },
  Effect.mapError(fail),
);
