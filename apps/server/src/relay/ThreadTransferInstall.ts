import { IsoDateTime, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { installPortableCodexHome } from "../provider/Drivers/PortableCodexHome.ts";
import { collectThreadAttachmentReferences } from "./ThreadAttachmentReferences.ts";
import { installThreadAttachments } from "./ThreadAttachmentTransfer.ts";
import { makeThreadCheckoutInstaller } from "./ThreadCheckoutInstall.ts";
import { ThreadHistoryBaselineImporter } from "./ThreadHistoryBaseline.ts";
import { stageThreadTransferArchive, ThreadTransferArchiveError } from "./ThreadTransferArchive.ts";
import type { ThreadHistoryArchiveManifest } from "./ThreadHistoryArchive.ts";

/** Install one complete archive under an already frozen destination. This is not
 * readiness: setup and relay ownership confirmation must still precede activation.
 */
export const installThreadTransferArchive = Effect.fn("installThreadTransferArchive")(
  function* (input: {
    readonly source: Pick<
      ThreadHistoryArchiveManifest,
      "threadId" | "environmentId" | "generation" | "operationId"
    >;
    readonly destination: {
      readonly environmentId: string;
      readonly projectId: ProjectId;
      readonly relayUrl: string;
      readonly generation: number;
    };
    readonly manifestSha256: string;
    readonly artifactDirectory: string;
    readonly recoveryRoot: string;
    readonly worktreesRoot: string;
    readonly stateDir: string;
    readonly attachmentsDir: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly codexVersion: string;
    readonly importedAt: IsoDateTime;
    readonly freshCheckoutRoot?: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const importer = yield* ThreadHistoryBaselineImporter;
    const target = {
      ...input.destination,
      threadId: ThreadId.make(input.source.threadId),
      operationId: input.source.operationId,
    };
    const fence = yield* makeThreadExecutionFence(sql).get(target.threadId);
    if (
      !fence ||
      fence.phase !== "frozen" ||
      fence.environmentId !== target.environmentId ||
      fence.projectId !== target.projectId ||
      fence.relayUrl !== target.relayUrl ||
      fence.generation !== target.generation ||
      fence.operationId !== target.operationId ||
      target.generation !== input.source.generation + 1 ||
      target.environmentId === input.source.environmentId
    )
      return yield* new ThreadTransferArchiveError({
        message: "The destination is not frozen for this archive's move.",
      });
    yield* fs.makeDirectory(input.recoveryRoot, { recursive: true, mode: 0o700 });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const scratch = yield* fs.makeTempDirectoryScoped({
          directory: input.recoveryRoot,
          prefix: "verify-transfer-",
        });
        const staged = yield* stageThreadTransferArchive({
          owner: input.source,
          expectedSha256: input.manifestSha256,
          artifactDirectory: input.artifactDirectory,
          destinationRoot: scratch,
          codexVersion: input.codexVersion,
        });
        const events = yield* Stream.runCollect(staged.history.events);
        let selectedInstance: ProviderInstanceId | undefined;
        for (const event of events) {
          if (event.type === "thread.created" || event.type === "thread.meta-updated") {
            if (event.payload.modelSelection)
              selectedInstance = event.payload.modelSelection.instanceId;
          }
        }
        if (selectedInstance !== input.providerInstanceId)
          return yield* new ThreadTransferArchiveError({
            message: "The destination provider instance does not match the transferred thread.",
          });
        const checkout = yield* makeThreadCheckoutInstaller(sql).install({
          ...target,
          manifestSha256: input.manifestSha256,
          workspace: staged.manifest.workspace,
          stagedWorkspaceRoot: staged.workspace.workspaceRoot,
          worktreesRoot: input.worktreesRoot,
          artifactDirectory: path.join(input.artifactDirectory, "workspace"),
          recoveryRoot: input.recoveryRoot,
          ...(input.freshCheckoutRoot ? { freshCheckoutRoot: input.freshCheckoutRoot } : {}),
        });
        const native =
          staged.native && staged.manifest.native
            ? yield* installPortableCodexHome({
                stateDir: input.stateDir,
                threadId: target.threadId,
                operationId: target.operationId,
                providerInstanceId: input.providerInstanceId,
                transferSha256: input.manifestSha256,
                manifest: staged.manifest.native,
                rolloutPath: path.join(input.artifactDirectory, "native", "rollout.jsonl"),
                codexVersion: input.codexVersion,
              })
            : null;
        yield* installThreadAttachments({
          threadId: target.threadId,
          attachments: yield* collectThreadAttachmentReferences(
            target.threadId,
            Stream.fromIterable(events),
          ),
          manifest: staged.manifest.attachments,
          artifactDirectory: staged.attachments.attachmentsDir,
          attachmentsDir: input.attachmentsDir,
        });
        const baseline = yield* importer.install({
          version: 1,
          manifestSha256: input.manifestSha256,
          source: staged.manifest.history,
          destination: {
            ...target,
            branch: checkout.branch,
            worktreePath: checkout.mode === "main" ? null : checkout.checkoutPath,
          },
          events,
          receipts: staged.history.receipts,
          importedAt: input.importedAt,
          nativeRuntime: native
            ? { ...native.resumeCursor, providerInstanceId: input.providerInstanceId }
            : null,
        });
        return {
          ...baseline,
          checkoutPath: checkout.checkoutPath,
          portableStateId: native?.resumeCursor.portableStateId ?? null,
        };
      }),
    );
  },
);
