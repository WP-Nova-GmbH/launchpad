import type { VcsError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type { VcsProcess, VcsProcessInput, VcsProcessOutput } from "../vcs/VcsProcess.ts";

export function isMissingExecutable(error: VcsError): boolean {
  return (
    error._tag === "VcsProcessSpawnError" &&
    error.command === "gh" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  );
}

/** Recognize only the GitHub missing-tool error and its known server wrappers. */
export function isGitHubCliMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  if (error._tag === "GitHubCliUnavailableError") return true;
  if (!("provider" in error) || error.provider !== "github") return false;
  if (error._tag === "PullRequestUnavailableError")
    return "reason" in error && error.reason === "cli-missing";
  if (error._tag === "PullRequestProviderError")
    return "reason" in error && error.reason === "missing-tool";
  return (
    error._tag === "SourceControlProviderError" &&
    "cause" in error &&
    isGitHubCliMissing(error.cause)
  );
}

export const isGitHubCliMissingCause = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => Cause.isFailReason(reason) && isGitHubCliMissing(reason.error));

/** Background callers retain their failure behavior; only the duplicate warning is omitted. */
export const logGitHubBackgroundWarning = (
  cause: Cause.Cause<unknown>,
  message: string,
  fields: Record<string, unknown>,
) => (isGitHubCliMissingCause(cause) ? Effect.void : Effect.logWarning(message, fields));

export class GitHubCliAvailability extends Context.Service<
  GitHubCliAvailability,
  {
    readonly run: (
      process: VcsProcess["Service"],
      input: VcsProcessInput,
      forceProbe?: boolean,
    ) => Effect.Effect<VcsProcessOutput, VcsError>;
  }
>()("t3/sourceControl/GitHubCliAvailability") {}

/** Shared by CLI execution and settings discovery, once per server environment. */
export const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const lock = yield* Semaphore.make(1);
  let probeResult: Result.Result<VcsProcessOutput, VcsError> | undefined;
  let retryAt = 0;
  let generation = 0;
  let reportedMissing = false;

  const reportMissing = Effect.gen(function* () {
    if (reportedMissing) return;
    reportedMissing = true;
    yield* Effect.logWarning(
      "GitHub integration unavailable: `gh` is missing from PATH. Install GitHub CLI, then rescan in Source Control settings. Background checks will retry in five minutes.",
    );
  });

  // Only executable detection holds the lock. Authentication and GitHub requests
  // run independently once a successful version probe establishes availability.
  const check = Effect.fnUntraced(function* (
    process: VcsProcess["Service"],
    input: VcsProcessInput,
    force: boolean,
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (
          !force &&
          probeResult !== undefined &&
          (Result.isSuccess(probeResult) || clock.currentTimeMillisUnsafe() < retryAt)
        ) {
          const output = yield* Effect.fromResult(probeResult);
          return { output, generation };
        }
        generation++;
        probeResult = yield* process
          .run({
            operation: "github.availability.probe",
            command: "gh",
            args: ["--version"],
            cwd: globalThis.process.cwd(),
            timeoutMs: 5_000,
            maxOutputBytes: 8_000,
            ...(input.env === undefined ? {} : { env: input.env }),
          })
          .pipe(Effect.result);
        // Any failed probe waits before retrying, including timeouts and nonzero exits.
        retryAt = clock.currentTimeMillisUnsafe() + 5 * 60_000;
        if (Result.isFailure(probeResult)) {
          if (isMissingExecutable(probeResult.failure)) yield* reportMissing;
          return yield* probeResult.failure;
        }
        if (reportedMissing) {
          reportedMissing = false;
          yield* Effect.logInfo("GitHub CLI is available again; GitHub checks will resume.");
        }
        return { output: probeResult.success, generation };
      }),
    );
  });

  const run: GitHubCliAvailability["Service"]["run"] = Effect.fnUntraced(function* (
    process,
    input,
    forceProbe = false,
  ) {
    const checked = yield* check(process, input, forceProbe);
    if (forceProbe) return checked.output;
    return yield* process.run(input).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          if (!isMissingExecutable(error) || checked.generation !== generation) return;
          // The executable can disappear after a successful check. An older command
          // must not overwrite a newer rescan's result.
          generation++;
          probeResult = Result.fail(error);
          retryAt = clock.currentTimeMillisUnsafe() + 5 * 60_000;
          yield* reportMissing;
        }),
      ),
    );
  });

  return GitHubCliAvailability.of({ run });
});

export const layer = Layer.effect(GitHubCliAvailability, make);
