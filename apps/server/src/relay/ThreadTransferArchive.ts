import { makeThreadTransferSource } from "./ThreadTransferSource.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { copyFrozenNativeCheckpoint } from "./ThreadFrozenNativeArchive.ts";
import { flushThreadArtifactTree } from "./ThreadArtifactDurability.ts";
import { withSealedVmWorkloads } from "../vmWorkload.ts";
import * as NodeCrypto from "node:crypto";
import { ChatAttachment, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";
import {
  CodexConversationManifest,
  exportCodexConversation,
  importCodexConversation,
} from "../provider/Drivers/CodexConversationTransfer.ts";
import {
  makeThreadAttachmentCheckpoint,
  verifyThreadAttachmentCheckpointArchive,
} from "./ThreadAttachmentCheckpoint.ts";
import { threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import { collectThreadAttachmentReferences } from "./ThreadAttachmentReferences.ts";
import { exportThreadAttachments, importThreadAttachments } from "./ThreadAttachmentTransfer.ts";
import {
  inspectThreadHistoryArchive,
  makeThreadHistoryArchive,
  ThreadHistoryArchiveManifest,
} from "./ThreadHistoryArchive.ts";
import { exportThreadWorkspace, importThreadWorkspace } from "./ThreadWorkspaceTransfer.ts";
import { workspaceFileHash } from "./ThreadWorkspaceFiles.ts";
import { workspaceGitText } from "./ThreadWorkspaceGit.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";

import { ThreadTransferArchiveManifest } from "@t3tools/contracts/threadTransfer";
export { ThreadTransferArchiveManifest } from "@t3tools/contracts/threadTransfer";
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadTransferArchiveManifest),
);
const encodeAttachment = Schema.encodeSync(Schema.fromJsonString(ChatAttachment));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ThreadTransferArchiveManifest));
const decodeCursor = Schema.decodeUnknownEffect(Schema.Struct({ threadId: Schema.NonEmptyString }));
export class ThreadTransferArchiveError extends Schema.TaggedError<ThreadTransferArchiveError>()(
  "ThreadTransferArchiveError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadTransferArchiveError({ message });
const contains = (root: string, file: string, separator: string) =>
  file === root || file.startsWith(`${root}${separator}`);

/** The source remains fenced. Publishing the returned digest and committing ownership are separate durable operations. */
export function makeThreadTransferArchive(
  sql: SqlClient.SqlClient,
  events: Pick<OrchestrationEventStoreShape, "readAggregateRange">,
) {
  const history = makeThreadHistoryArchive(sql, events);
  const fences = makeThreadExecutionFence(sql);
  const exportFrozen = Effect.fn("ThreadTransferArchive.exportFrozen")(function* (input: {
    readonly threadId: string;
    readonly environmentId: string;
    readonly generation: number;
    readonly operationId: string;
    readonly artifactRoot: string;
    readonly attachmentsDir: string;
    readonly serverDataRoot: string;
    readonly native: { readonly codexHome: string; readonly rolloutPath: string } | null;
    readonly nativeCheckpointTurnId?: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sessions = yield* ProviderSessionRuntimeRepository;
    const fence = yield* fences.get(input.threadId);
    if (
      !fence ||
      fence.phase !== "frozen" ||
      fence.frozenSequence === null ||
      fence.operationId !== input.operationId ||
      fence.generation !== input.generation ||
      fence.environmentId !== input.environmentId
    )
      return yield* fail("Freeze this exact thread placement before exporting it.");
    const [project] = yield* sql<{
      workspaceRoot: string;
    }>`SELECT COALESCE(t.worktree_path, p.workspace_root) AS "workspaceRoot"
      FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = ${input.threadId} AND t.project_id = ${fence.projectId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
    if (!project) return yield* fail("The thread has no current source checkout.");
    const resolvedWorkspaceRoot = yield* fs.realPath(project.workspaceRoot);
    const capture = yield* makeCheckoutCapture(sql).get(input.operationId);
    if (capture) {
      const gitCommonRoot = yield* fs.realPath(
        yield* workspaceGitText(resolvedWorkspaceRoot, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      );
      if (
        capture.phase !== "capturing" ||
        capture.threadId !== input.threadId ||
        capture.environmentId !== input.environmentId ||
        capture.generation !== input.generation ||
        capture.checkoutRoot !== resolvedWorkspaceRoot ||
        capture.gitCommonRoot !== gitCommonRoot
      )
        return yield* fail("The source checkout changed after its snapshot admission.");
    }
    // Ownership is frozen before resolving this binding. Keep the export on the
    // admitted canonical path even if its registered alias changes afterward.
    const workspaceRoot = capture?.checkoutRoot ?? resolvedWorkspaceRoot;
    const runtime = yield* sessions.getByThreadId({ threadId: ThreadId.make(input.threadId) });
    let nativeThreadId: string | null = null;
    if (Option.isSome(runtime)) {
      if (
        runtime.value.adapterKey !== "codex" ||
        runtime.value.status !== "stopped" ||
        (!input.native && input.nativeCheckpointTurnId === undefined)
      )
        return yield* fail(
          "Stop the verified Codex session before exporting its native conversation.",
        );
      nativeThreadId = (yield* decodeCursor(runtime.value.resumeCursor)).threadId;
    } else if (input.native)
      return yield* fail("Native conversation has no matching thread runtime record.");
    for (const configuredRoot of [
      input.serverDataRoot,
      input.attachmentsDir,
      ...(input.native ? [input.native.codexHome] : []),
    ]) {
      if (!(yield* fs.exists(configuredRoot))) continue;
      const stateRoot = yield* fs.realPath(configuredRoot);
      if (
        contains(workspaceRoot, stateRoot, path.sep) &&
        !path
          .relative(workspaceRoot, stateRoot)
          .split(path.sep)
          .some((part) => part === ".t3" || part === "node_modules")
      )
        return yield* fail(
          "Server and provider storage must be outside the transferable workspace files.",
        );
    }
    const requestedRoot = path.resolve(input.artifactRoot);
    let ancestor = requestedRoot;
    while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
    const resolved = path.resolve(
      yield* fs.realPath(ancestor),
      path.relative(ancestor, requestedRoot),
    );
    if (contains(workspaceRoot, resolved, path.sep))
      return yield* fail("Transfer storage must be outside the source checkout.");
    yield* fs.makeDirectory(requestedRoot, { recursive: true, mode: 0o700 });
    const artifactRoot = yield* fs.realPath(requestedRoot);
    if (contains(workspaceRoot, artifactRoot, path.sep))
      return yield* fail("Transfer storage must be outside the source checkout.");
    const directory = yield* fs.makeTempDirectory({ directory: artifactRoot, prefix: "thread-" });
    return yield* Effect.gen(function* () {
      const savedHistory = yield* history.exportFrozen({ ...input, artifactRoot: directory });
      yield* fs.rename(savedHistory.directory, path.join(directory, "history"));
      const inspected = yield* inspectThreadHistoryArchive({
        owner: input,
        manifest: savedHistory.manifest,
        directory: path.join(directory, "history"),
      });
      const references = yield* collectThreadAttachmentReferences(input.threadId, inspected.events);
      const savedAttachments = yield* Effect.gen(function* () {
        if (input.nativeCheckpointTurnId === undefined) {
          const saved = yield* exportThreadAttachments({
            threadId: input.threadId,
            attachments: references,
            attachmentsDir: input.attachmentsDir,
            artifactRoot: directory,
          });
          yield* fs.rename(saved.directory, path.join(directory, "attachments"));
          return { ...saved, verify: undefined };
        }
        const store = makeThreadAttachmentCheckpoint(sql, events);
        const key = threadCheckpointId(input.nativeCheckpointTurnId, input.operationId);
        const point = yield* store.get(input.threadId, input.generation, key);
        if (
          !point ||
          point.environmentId !== input.environmentId ||
          point.sourceSequence !== savedHistory.manifest.sourceSequence
        )
          return yield* fail("The exact frozen chat attachment checkpoint is missing.");
        const { manifest } = yield* verifyThreadAttachmentCheckpointArchive(point, input.threadId);
        const expected = new Map(
          references.map((attachment) => [attachment.id, encodeAttachment(attachment)]),
        );
        if (
          expected.size !== manifest.files.length ||
          manifest.files.some(
            (file) => expected.get(file.attachment.id) !== encodeAttachment(file.attachment),
          )
        )
          return yield* fail("Frozen attachments do not match the source history.");
        const target = path.join(directory, "attachments");
        yield* fs.copy(point.directory, target);
        const verify = Effect.gen(function* () {
          const current = yield* store.get(input.threadId, input.generation, key);
          if (
            current?.directory !== point.directory ||
            current.manifestSha256 !== point.manifestSha256 ||
            current.sourceSequence !== point.sourceSequence
          )
            return yield* fail("Frozen attachment ownership changed during export.");
          yield* verifyThreadAttachmentCheckpointArchive(point, input.threadId);
          yield* verifyThreadAttachmentCheckpointArchive(
            { ...point, directory: target },
            input.threadId,
          );
        });
        yield* verify;
        return { directory: target, manifest, verify };
      });
      let native: CodexConversationManifest | null = null;
      let nativeSources: ReadonlyArray<{ readonly rolloutPath: string; readonly sha256: string }> =
        [];
      let verifyFrozenNative:
        | Effect.Success<ReturnType<typeof copyFrozenNativeCheckpoint>>["verify"]
        | undefined;
      if (input.nativeCheckpointTurnId !== undefined && nativeThreadId) {
        const copied = yield* copyFrozenNativeCheckpoint(sql, {
          ...input,
          turnId: input.nativeCheckpointTurnId,
          nativeThreadId,
          sourceSequence: savedHistory.manifest.sourceSequence,
          destinationDirectory: path.join(directory, "native"),
        });
        native = copied.native;
        verifyFrozenNative = copied.verify;
      } else if (input.native && nativeThreadId) {
        const attachmentRoot = savedAttachments.manifest.files.length
          ? yield* fs.realPath(input.attachmentsDir)
          : input.attachmentsDir;
        const saved = yield* exportCodexConversation({
          ...input.native,
          threadId: nativeThreadId,
          artifactRoot: directory,
          referencedFileRoots: [workspaceRoot],
          referencedFiles: savedAttachments.manifest.files.length
            ? savedAttachments.manifest.files.map((file) =>
                path.join(attachmentRoot, attachmentRelativePath(file.attachment)!),
              )
            : [],
        });
        native = saved.manifest;
        nativeSources = saved.sourceRollouts;
        yield* fs.rename(saved.directory, path.join(directory, "native"));
      } else {
        // A missing native record must never turn a prior conversation into a fresh provider thread.
        const prior =
          yield* sql`SELECT 1 FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
          AND (event_type IN ('thread.turn-start-requested', 'thread.session-set') OR
            (event_type = 'thread.message-sent' AND json_extract(payload_json, '$.role') = 'assistant')) LIMIT 1`;
        if (prior.length)
          return yield* fail("Existing provider work has no transferable native conversation.");
      }
      const workspace = yield* exportThreadWorkspace({
        threadId: input.threadId,
        workspaceRoot,
        artifactRoot: directory,
      });
      yield* fs.rename(workspace.directory, path.join(directory, "workspace"));
      // Earlier components must still match after the potentially longer workspace copy.
      if (verifyFrozenNative) yield* verifyFrozenNative;
      if (savedAttachments.verify) yield* savedAttachments.verify;
      if (
        !verifyFrozenNative &&
        native &&
        input.native &&
        (yield* workspaceFileHash(input.native.rolloutPath)).sha256 !== native.sha256
      )
        return yield* fail("The native conversation changed during the thread export.");
      for (const source of nativeSources)
        if ((yield* workspaceFileHash(source.rolloutPath)).sha256 !== source.sha256)
          return yield* fail("A native history dependency changed during the thread export.");
      for (const file of verifyFrozenNative ? [] : (native?.files ?? [])) {
        if (
          (yield* fs.realPath(file.sourcePath)) !== file.sourcePath ||
          (yield* workspaceFileHash(file.sourcePath)).sha256 !== file.sha256
        )
          return yield* fail("A native Codex file changed during the thread export.");
      }
      for (const file of savedAttachments.verify ? [] : savedAttachments.manifest.files) {
        const name = attachmentRelativePath(file.attachment);
        if (
          !name ||
          (yield* workspaceFileHash(path.join(input.attachmentsDir, name))).sha256 !== file.sha256
        )
          return yield* fail("A thread attachment changed during export.");
      }
      const current = yield* fences.get(input.threadId);
      const currentRuntime = yield* sessions.getByThreadId({
        threadId: ThreadId.make(input.threadId),
      });
      if (
        !current ||
        current.phase !== "frozen" ||
        current.operationId !== input.operationId ||
        current.environmentId !== input.environmentId ||
        current.generation !== input.generation ||
        current.frozenSequence !== savedHistory.manifest.sourceSequence ||
        Option.isSome(currentRuntime) !== Option.isSome(runtime)
      )
        return yield* fail("Source ownership or runtime changed during export.");
      if (
        Option.isSome(currentRuntime) &&
        (currentRuntime.value.adapterKey !== "codex" ||
          currentRuntime.value.status !== "stopped" ||
          (yield* decodeCursor(currentRuntime.value.resumeCursor)).threadId !== nativeThreadId)
      )
        return yield* fail("Source native conversation changed during export.");
      yield* history.verifyFrozen(savedHistory.manifest);
      const manifest: ThreadTransferArchiveManifest = {
        format: "launchpad-thread-transfer-v1",
        history: savedHistory.manifest,
        workspace: workspace.manifest,
        attachments: savedAttachments.manifest,
        native,
      };
      const file = path.join(directory, "manifest.json");
      yield* fs.writeFileString(file, yield* encodeManifest(manifest), { mode: 0o600, flag: "wx" });
      yield* flushThreadArtifactTree(directory);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* fs.open(artifactRoot, { flag: "r" })).sync;
        }),
      );
      return { directory, manifest, sha256: (yield* workspaceFileHash(file)).sha256 };
    }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
  });
  const exportSource = Effect.fn("ThreadTransferArchive.exportSource")(function* (
    input: Omit<Parameters<typeof exportFrozen>[0], "native" | "nativeCheckpointTurnId">,
    provider: Pick<ProviderServiceShape, "listSessions" | "checkpointConversation">,
  ) {
    const source = yield* makeThreadTransferSource(sql, events, provider).freeze(input);
    return yield* withSealedVmWorkloads(
      input.operationId,
      exportFrozen({
        ...input,
        native: null,
        ...(source.nativeCheckpointTurnId === null
          ? {}
          : { nativeCheckpointTurnId: source.nativeCheckpointTurnId }),
      }),
    );
  });
  return {
    exportSource,
    exportFrozen: (input: Parameters<typeof exportFrozen>[0]) =>
      withSealedVmWorkloads(input.operationId, exportFrozen(input)),
  };
}

/** Materialize all components in quarantine. This does not install events, grant execution, or release the source. */
export const stageThreadTransferArchive = Effect.fn("stageThreadTransferArchive")(
  function* (input: {
    readonly owner: Pick<
      ThreadHistoryArchiveManifest,
      "threadId" | "environmentId" | "generation" | "operationId"
    >;
    readonly expectedSha256: string;
    readonly artifactDirectory: string;
    readonly destinationRoot: string;
    readonly codexVersion: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(input.artifactDirectory);
    const manifestPath = path.join(root, "manifest.json");
    const info = yield* fs.stat(manifestPath);
    if (
      (yield* fs.realPath(manifestPath)) !== manifestPath ||
      info.type !== "File" ||
      info.size > BigInt(32 * 1024 * 1024)
    )
      return yield* fail("The transfer manifest is not a bounded regular artifact.");
    const bytes = yield* fs.readFile(manifestPath);
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256)
      return yield* fail("The transfer manifest does not match the committed source digest.");
    const manifest = yield* decodeManifest(new TextDecoder().decode(bytes));
    if (
      manifest.attachments.threadId !== input.owner.threadId ||
      manifest.workspace.threadId !== input.owner.threadId
    )
      return yield* fail("Thread transfer contains components from another thread.");
    const history = yield* inspectThreadHistoryArchive({
      owner: input.owner,
      manifest: manifest.history,
      directory: path.join(root, "history"),
    });
    const references = yield* collectThreadAttachmentReferences(
      input.owner.threadId,
      history.events,
    );
    yield* fs.makeDirectory(input.destinationRoot, { recursive: true, mode: 0o700 });
    const directory = yield* fs.makeTempDirectory({
      directory: input.destinationRoot,
      prefix: "thread-",
    });
    return yield* Effect.gen(function* () {
      const attachments = yield* importThreadAttachments({
        threadId: input.owner.threadId,
        attachments: references,
        manifest: manifest.attachments,
        artifactDirectory: path.join(root, "attachments"),
        destinationRoot: directory,
      });
      const workspace = yield* importThreadWorkspace({
        threadId: input.owner.threadId,
        manifest: manifest.workspace,
        artifactDirectory: path.join(root, "workspace"),
        destinationRoot: directory,
      });
      const native = manifest.native
        ? yield* importCodexConversation({
            manifest: manifest.native,
            rolloutPath: path.join(root, "native", "rollout.jsonl"),
            destinationRoot: directory,
            codexVersion: input.codexVersion,
          })
        : null;
      return { directory, history, workspace, attachments, native, manifest };
    }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
  },
);
