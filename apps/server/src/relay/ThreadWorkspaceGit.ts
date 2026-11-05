import * as Effect from "effect/Effect";
import { ProcessRunner } from "../processRunner.ts";
import { workspaceFailure } from "./ThreadWorkspaceTransferError.ts";

export const workspaceGit = Effect.fnUntraced(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { env?: NodeJS.ProcessEnv; stdin?: string; allowFailure?: boolean },
) {
  const runner = yield* ProcessRunner;
  const result = yield* runner
    .run({
      command: "git",
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...args,
      ],
      cwd,
      timeout: "5 minutes",
      maxOutputBytes: 32 * 1024 * 1024,
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        ...options?.env,
      },
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    })
    .pipe(Effect.mapError(() => workspaceFailure("Git could not prepare a portable workspace.")));
  if (
    result.timedOut ||
    result.stdoutTruncated ||
    result.stdoutInvalidUtf8 ||
    (!options?.allowFailure && result.code !== 0)
  )
    return yield* workspaceFailure(`Git ${args[0]} could not verify the complete workspace state.`);
  return result;
});
export const workspaceGitText = Effect.fnUntraced(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
) {
  return (yield* workspaceGit(cwd, args, env ? { env } : undefined)).stdout.trim();
});
