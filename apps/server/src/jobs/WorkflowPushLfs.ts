import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type ExecuteGitInput,
  type GitVcsDriver,
  workflowGitEnvironment,
} from "../vcs/GitVcsDriver.ts";

const operation = "WorkflowActions.checkLfs";
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const objectMetadata = /^([a-f0-9]+) (blob|commit|tag|tree) (\d+)$/;
const pointerSizeCutoff = 1024;
const pointerHeaders = new Set([
  "version https://git-lfs.github.com/spec/v1",
  "version https://hawser.github.com/spec/v1",
  "version http://git-media.io/v/2",
]);

function isLfsUploadPointer(contents: string): boolean {
  const fields = contents
    .trim()
    .split(/\r?\n/)
    .filter((line) => line !== "" && !/^ext-\d-\w/.test(line));
  return (
    fields.length === 3 &&
    pointerHeaders.has(fields[0] ?? "") &&
    /^oid sha256:[a-f0-9]{64}$/.test(fields[1] ?? "") &&
    /^size (?:\+?\d+|-0+)$/.test(fields[2] ?? "")
  );
}

export const workflowPushNeedsLfsUpload = Effect.fn("workflowPushNeedsLfsUpload")(function* (
  git: GitVcsDriver["Service"],
  input: { cwd: string; commitSha: string; baseSha: string; publishedSha: string | null },
): Effect.fn.Return<boolean, GitCommandError> {
  const { cwd, commitSha, baseSha, publishedSha } = input;
  const failure = (detail: string) =>
    new GitCommandError({ operation, command: "git", cwd, detail });
  const read = ({ args, ...options }: Pick<ExecuteGitInput, "args" | "stdin" | "maxOutputBytes">) =>
    git
      .execute({
        operation,
        cwd,
        args: ["--no-replace-objects", ...args],
        env: { ...workflowGitEnvironment, GIT_NO_LAZY_FETCH: "1" },
        ...options,
      })
      .pipe(
        Effect.flatMap((result) =>
          result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated
            ? Effect.fail(failure("Could not read the Git objects for the workflow LFS check."))
            : Effect.succeed(result.stdout),
        ),
      );

  if (![commitSha, baseSha, publishedSha ?? baseSha].every((sha) => objectId.test(sha))) {
    return yield* failure("Invalid commit ID for the workflow LFS check.");
  }
  // Walk every newly published commit. A pointer can require upload even if a later commit removes it.
  const list = yield* read({
    args: [
      "rev-list",
      "--objects",
      "--no-object-names",
      commitSha,
      `^${baseSha}`,
      ...(publishedSha === null ? [] : [`^${publishedSha}`]),
      "--",
    ],
    maxOutputBytes: 1024 * 1024,
  });
  if (list === "") return false;
  const ids = list.replace(/\n$/, "").split("\n");
  if (!ids.every((id) => objectId.test(id) && id.length === commitSha.length)) {
    return yield* failure("Git returned an invalid object list for the workflow LFS check.");
  }

  const metadata = yield* read({
    args: ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    stdin: `${ids.join("\n")}\n`,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const rows = metadata.replace(/\n$/, "").split("\n");
  if (rows.length !== ids.length) {
    return yield* failure("Git returned incomplete object metadata for the workflow LFS check.");
  }
  const candidates: string[] = [];
  for (const [index, row] of rows.entries()) {
    const match = objectMetadata.exec(row);
    const size = Number(match?.[3]);
    const id = ids[index];
    if (id === undefined || match?.[1] !== id || !Number.isSafeInteger(size)) {
      return yield* failure("Git returned invalid object metadata for the workflow LFS check.");
    }
    if (match[2] === "blob" && size > 0 && size < pointerSizeCutoff) candidates.push(id);
  }

  for (let index = 0; index < candidates.length; index += 4) {
    const matches = yield* Effect.forEach(
      candidates.slice(index, index + 4),
      (id) =>
        read({ args: ["cat-file", "blob", id], maxOutputBytes: pointerSizeCutoff }).pipe(
          Effect.map(isLfsUploadPointer),
        ),
      { concurrency: 4 },
    );
    if (matches.some(Boolean)) return true;
  }
  return false;
});
