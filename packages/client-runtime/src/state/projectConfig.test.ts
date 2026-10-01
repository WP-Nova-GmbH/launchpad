import { describe, expect, it } from "@effect/vitest";
import {
  ProjectReadFileError,
  type ProjectFileName,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { resolveProjectConfig } from "./projectConfig.ts";

const content = (relativePath: ProjectFileName, contents: string, truncated = false) =>
  AsyncResult.success({ relativePath, contents, truncated, byteLength: contents.length });
const readFailure = (relativePath: ProjectFileName, notFound?: boolean) =>
  AsyncResult.failure<ProjectReadFileResult, ProjectReadFileError>(
    Cause.fail(
      new ProjectReadFileError({
        cwd: "/workspace",
        relativePath,
        failure: "operation_failed",
        ...(notFound === undefined ? {} : { notFound }),
      }),
    ),
  );
const preferred = content("launchpad.json", '{"defaultThreadEnvMode":"worktree"}');
const legacy = content("t3.json", '{"defaultThreadEnvMode":"local","iconPath":"legacy.svg"}');
const encodeReadError = Schema.encodeSync(ProjectReadFileError);
const decodeReadError = Schema.decodeUnknownSync(ProjectReadFileError);

function select(
  primary: AsyncResult.AsyncResult<ProjectReadFileResult, ProjectReadFileError>,
  fallback = legacy,
) {
  return resolveProjectConfig((name) => (name === "launchpad.json" ? primary : fallback));
}

describe("repository config selection", () => {
  it("prefers the entire launchpad file without merging legacy fields", () => {
    expect(select(preferred)).toMatchObject({
      _tag: "Success",
      value: { fileName: "launchpad.json", config: { defaultThreadEnvMode: "worktree" } },
    });
    const result = select(preferred);
    if (result._tag === "Success") expect(result.value?.config).not.toHaveProperty("iconPath");
  });
  it("uses legacy contents only after a confirmed missing preferred file", () => {
    expect(select(readFailure("launchpad.json", true))).toMatchObject({
      _tag: "Success",
      value: { fileName: "t3.json", config: { defaultThreadEnvMode: "local" } },
    });
  });
  it("returns no config when neither file exists", () => {
    expect(resolveProjectConfig((name) => readFailure(name, true))).toMatchObject({
      _tag: "Success",
      value: null,
    });
  });
  it.each([false, undefined])(
    "preserves read errors instead of falling back (missing=%s)",
    (notFound) => {
      expect(select(readFailure("launchpad.json", notFound))._tag).toBe("Failure");
    },
  );
  it.each([
    ["ENOENT", "realpath-target", undefined, true],
    ["ENOENT", "open", undefined, true],
    ["ENOENT", "realpath-workspace-root", undefined, false],
    ["ENOENT", "realpath-target", false, false],
    ["EACCES", "realpath-target", undefined, false],
    ["EPERM", "open", undefined, false],
  ] as const)(
    "handles older environment read errors (%s, %s, %s)",
    (code, operation, notFound, fallsBack) => {
      const error = decodeReadError(
        encodeReadError(
          new ProjectReadFileError({
            cwd: "/workspace",
            relativePath: "launchpad.json",
            failure: "operation_failed",
            operation,
            ...(notFound === undefined ? {} : { notFound }),
            cause: new Error("Workspace file operation failed", {
              cause: new Error(`${code}: file operation failed`),
            }),
          }),
        ),
      );
      const result = select(AsyncResult.failure(Cause.fail(error)));
      if (fallsBack) {
        expect(result).toMatchObject({ _tag: "Success", value: { fileName: "t3.json" } });
      } else {
        expect(result._tag).toBe("Failure");
      }
    },
  );
  it.each(["{broken", '{"worktreeSubmodules":"invalid"}'])(
    "reports invalid preferred contents without using legacy data: %s",
    (contents) => {
      expect(select(content("launchpad.json", contents))).toMatchObject({
        _tag: "Success",
        value: { fileName: "launchpad.json", config: null },
      });
    },
  );
  it("does not read legacy data while the preferred file is loading", () => {
    const result = resolveProjectConfig((name) => {
      if (name === "t3.json") throw new Error("Legacy file must not be read yet");
      return AsyncResult.initial<ProjectReadFileResult, ProjectReadFileError>(true);
    });
    expect(result._tag).toBe("Initial");
    expect(result.waiting).toBe(true);
  });
  it("does not retain stale config after a read failure", () => {
    const failed = readFailure("launchpad.json", false);
    const result = select(
      AsyncResult.failure(failed.cause, { previousSuccess: Option.some(preferred) }),
    );
    expect(AsyncResult.value(result)).toMatchObject({ _tag: "None" });
  });
  it("rejects truncated contents without falling back", () => {
    expect(select(content("launchpad.json", "{}", true))).toMatchObject({
      _tag: "Success",
      value: { fileName: "launchpad.json", config: null },
    });
  });
});
