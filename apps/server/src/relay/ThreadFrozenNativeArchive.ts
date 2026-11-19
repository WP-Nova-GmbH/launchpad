import {
  CodexConversationManifest,
  ThreadNativeCheckpointArchiveManifest,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeThreadNativeCheckpoint,
  threadCheckpointId,
  ThreadNativeCheckpointError,
} from "./ThreadNativeCheckpoint.ts";
import { verifyNativeCheckpointArchive } from "./ThreadNativeCheckpointTransfer.ts";
const decodeNative = Schema.decodeEffect(Schema.fromJsonString(CodexConversationManifest));
const decodeDirectories = Schema.decodeUnknownEffect(
  ThreadNativeCheckpointArchiveManifest.fields.directories,
);
/** Copy the already frozen native bytes, including referenced files that may since have changed in the checkout. */
export const copyFrozenNativeCheckpoint = Effect.fn("copyFrozenNativeCheckpoint")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly generation: number;
    readonly environmentId: string;
    readonly operationId: string;
    readonly nativeThreadId: string;
    readonly sourceSequence: number;
    readonly destinationDirectory: string;
  },
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const checkpoints = makeThreadNativeCheckpoint(sql),
    key = threadCheckpointId(input.turnId, input.operationId);
  const point = yield* checkpoints.get(input.threadId, input.generation, key);
  if (
    !point ||
    point.turnId !== input.turnId ||
    point.captureOperationId !== input.operationId ||
    point.environmentId !== input.environmentId ||
    point.nativeThreadId !== input.nativeThreadId ||
    point.sourceSequence !== input.sourceSequence
  )
    return yield* new ThreadNativeCheckpointError({
      message: "The exact frozen native checkpoint is missing.",
    });
  const manifestPath = path.join(point.directory, "manifest.json");
  if ((yield* fs.stat(manifestPath)).size > 2n * 1024n * 1024n)
    return yield* new ThreadNativeCheckpointError({
      message: "Frozen native metadata is too large.",
    });
  const native = yield* decodeNative(yield* fs.readFileString(manifestPath));
  const directories = [];
  for (const name of yield* fs.readDirectory(point.directory))
    if ((yield* fs.stat(path.join(point.directory, name))).type === "Directory")
      directories.push(name);
  const header = {
    format: "launchpad-native-checkpoint-v1" as const,
    ...input,
    sourceEnvironmentId: input.environmentId,
    captureOperationId: input.operationId,
    nativeManifestSha256: point.manifestSha256,
    archiveSha256: point.archiveSha256,
    directories: yield* decodeDirectories(directories),
    native,
  };
  yield* verifyNativeCheckpointArchive(point.directory, header);
  yield* fs.copy(point.directory, input.destinationDirectory);
  return yield* Effect.gen(function* () {
    yield* verifyNativeCheckpointArchive(input.destinationDirectory, header);
    yield* verifyNativeCheckpointArchive(point.directory, header);
    const current = yield* checkpoints.get(input.threadId, input.generation, key);
    if (
      current?.directory !== point.directory ||
      current.archiveSha256 !== point.archiveSha256 ||
      current.sourceSequence !== point.sourceSequence
    )
      return yield* new ThreadNativeCheckpointError({
        message: "Frozen native ownership changed during export.",
      });
    return {
      native,
      verify: verifyNativeCheckpointArchive(input.destinationDirectory, header).pipe(
        Effect.andThen(verifyNativeCheckpointArchive(point.directory, header)),
      ),
    };
  }).pipe(
    Effect.onError(() =>
      fs.remove(input.destinationDirectory, { recursive: true }).pipe(Effect.ignore),
    ),
  );
});
