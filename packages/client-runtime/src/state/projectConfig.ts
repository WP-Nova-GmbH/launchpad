import {
  PROJECT_FILE_NAMES,
  ProjectReadFileError,
  type ProjectFileName,
  type ProjectReadFileResult,
  type ResolvedProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";

const isReadError = Schema.is(ProjectReadFileError);

function isMissingFile(error: unknown): boolean {
  if (!isReadError(error)) return false;
  if (error.notFound !== undefined) return error.notFound;
  // Older environments serialize Node errors through Schema.Defect, which drops
  // `code` but preserves the cause's message. Only recognize a target-file ENOENT;
  // a missing workspace or any other read failure must still stop selection.
  return (
    error.failure === "operation_failed" &&
    (error.operation === "realpath-target" ||
      error.operation === "open" ||
      error.operation === "stat" ||
      error.operation === "read") &&
    error.cause instanceof Error &&
    error.cause.cause instanceof Error &&
    error.cause.cause.message.startsWith("ENOENT:")
  );
}

/** Selects one complete config, preserving loading/errors instead of masking them with legacy data. */
export function resolveProjectConfig<E>(
  read: (fileName: ProjectFileName) => AsyncResult.AsyncResult<ProjectReadFileResult, E>,
): AsyncResult.AsyncResult<ResolvedProjectFile | null, E> {
  for (const fileName of PROJECT_FILE_NAMES) {
    const result = read(fileName);
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      if (!result.waiting && isMissingFile(error)) continue;
      return AsyncResult.failure(result.cause, { waiting: result.waiting });
    }
    return AsyncResult.map(result, (data) => ({
      fileName,
      config: data.truncated ? null : parseT3ProjectFile(data.contents),
    }));
  }
  return AsyncResult.success(null);
}
