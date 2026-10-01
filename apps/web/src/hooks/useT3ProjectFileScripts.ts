import {
  T3_PROJECT_FILE_NAME,
  LEGACY_T3_PROJECT_FILE_NAME,
  ProjectReadFileError,
  type EnvironmentId,
  type ProjectFileName,
  type ResolvedProjectFile,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { projectEnvironment } from "~/state/projects";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];
const EMPTY_CONFIG = Atom.make(AsyncResult.success<ResolvedProjectFile | null>(null));
const isReadError = Schema.is(ProjectReadFileError);

export interface T3ProjectFileState {
  status: "loading" | "missing" | "invalid" | "error" | "valid";
  fileName: ProjectFileName;
  file: T3ProjectFile | null;
  error: string | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
}

/** Keeps the selected filename with its validation state for truthful import and error labels. */
export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  const result = useAtomValue(
    cwd === null ? EMPTY_CONFIG : projectEnvironment.projectConfig({ environmentId, cwd }),
  );
  return useMemo(() => {
    const data = Option.getOrNull(AsyncResult.value(result));
    const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;
    const fileName =
      data?.fileName ??
      (isReadError(cause) && cause.relativePath === LEGACY_T3_PROJECT_FILE_NAME
        ? LEGACY_T3_PROJECT_FILE_NAME
        : T3_PROJECT_FILE_NAME);
    return {
      status:
        cause !== null
          ? "error"
          : data !== null
            ? data.config === null
              ? "invalid"
              : "valid"
            : result.waiting || result._tag === "Initial"
              ? "loading"
              : "missing",
      fileName,
      file: cause === null ? (data?.config ?? null) : null,
      error:
        cause instanceof Error
          ? cause.message
          : cause !== null
            ? "Could not read project configuration."
            : null,
      scripts: cause === null ? (data?.config?.scripts ?? NO_SCRIPTS) : NO_SCRIPTS,
    };
  }, [result]);
}
