import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type VcsError,
  VcsProcessExitError,
  type VcsProcessExitFailureKind,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as OrganizationSourceControlCredentials from "../relay/OrganizationSourceControlCredentials.ts";
import { hasRunnerSourceControlCredential, runnerSourceControlEnv } from "./runnerCredentials.ts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spawnCwd?: string;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Present on real process output; optional so narrow test doubles remain lightweight. */
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
}

export class VcsProcess extends Context.Service<
  VcsProcess,
  {
    readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
  }
>()("t3/vcs/VcsProcess") {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

const classifyNonZeroExit = (command: string, stderr: string): VcsProcessExitFailureKind => {
  const normalized = stderr.toLowerCase();

  if (
    normalized.includes("authentication failed") ||
    normalized.includes("not logged in") ||
    normalized.includes("gh auth login") ||
    normalized.includes("glab auth login") ||
    normalized.includes("az devops login") ||
    normalized.includes("please run az login") ||
    normalized.includes("no oauth token") ||
    normalized.includes("unauthorized")
  ) {
    return "authentication";
  }

  if (
    normalized.includes("api rate limit") ||
    normalized.includes("rate limit exceeded") ||
    normalized.includes("secondary rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("http 429")
  ) {
    return "rate-limited";
  }

  if (
    (command === "gh" &&
      (normalized.includes("could not resolve to a pullrequest") ||
        normalized.includes("repository.pullrequest") ||
        normalized.includes("no pull requests found for branch") ||
        normalized.includes("pull request not found"))) ||
    (command === "glab" &&
      (normalized.includes("merge request not found") ||
        normalized.includes("not found") ||
        normalized.includes("404"))) ||
    (command === "az" &&
      normalized.includes("pull request") &&
      (normalized.includes("not found") || normalized.includes("does not exist")))
  ) {
    return "not-found";
  }

  return "command-failed";
};

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  // Provided on a managed executor, where the organization's GitHub
  // installation stands in for a runner token nobody configured by hand
  // (ADR-0015). Absent on personal machines, which keep their ambient logins.
  const organizationCredentials = yield* Effect.serviceOption(
    OrganizationSourceControlCredentials.OrganizationSourceControlCredentials,
  );
  // Applied on top of whatever environment the caller asks for: a caller
  // setting GIT_TERMINAL_PROMPT for a clone must not lose the credential.
  const resolveRunnerEnv = (
    requested: NodeJS.ProcessEnv | undefined,
  ): Effect.Effect<NodeJS.ProcessEnv | null> => {
    const baseEnv = requested ?? globalThis.process.env;
    const withCredential = (organizationToken: string | null) =>
      runnerSourceControlEnv(baseEnv, organizationToken) ?? requested ?? null;
    return hasRunnerSourceControlCredential() || Option.isNone(organizationCredentials)
      ? Effect.sync(() => withCredential(null))
      : Effect.map(organizationCredentials.value.github, (credential) =>
          withCredential(credential?.token ?? null),
        );
  };

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const baseError = {
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      argumentCount: input.args.length,
    };

    // Every VCS subprocess the server runs is server-initiated — agents reach
    // git through their own shell, never through here — so this is where the
    // runner's push credential is granted (ADR-0009). It resolves to null when
    // no runner credential is configured, leaving the inherited environment
    // exactly as it was.
    const resolvedEnv = yield* resolveRunnerEnv(input.env);

    const result = yield* processRunner
      .run({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(resolvedEnv !== null ? { env: resolvedEnv } : {}),
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        truncatedMarker: input.appendTruncationMarker ? OUTPUT_TRUNCATED_MARKER : "",
        timeoutBehavior: "error",
      })
      .pipe(
        Effect.mapError(
          Match.valueTags({
            ProcessSpawnError: (error) =>
              VcsProcessSpawnError.fromProcessSpawnError(baseError, error),
            ProcessOutputLimitError: (error) =>
              new VcsProcessOutputLimitError({
                ...baseError,
                stream: error.stream,
                maxBytes: error.maxBytes,
                observedBytes: error.observedBytes,
              }),
            ProcessTimeoutError: (error) =>
              VcsProcessTimeoutError.fromProcessTimeoutError(baseError, error),
            ProcessStdinError: (error) =>
              new VcsProcessStdinWriteError({
                ...baseError,
                stdinBytes: error.stdinBytes,
                cause: error.cause,
              }),
            ProcessReadError: (error) =>
              new VcsProcessOutputReadError({
                ...baseError,
                stream: error.stream,
                cause: error.cause,
              }),
          }),
        ),
      );

    if (result.code === null) {
      return yield* new VcsProcessMissingExitCodeError(baseError);
    }

    if (!input.allowNonZeroExit && result.code !== 0) {
      return yield* VcsProcessExitError.fromProcessExit(
        baseError,
        {
          exitCode: result.code,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
        },
        classifyNonZeroExit(input.command, result.stderr),
      );
    }

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutInvalidUtf8: result.stdoutInvalidUtf8 ?? false,
      stderrInvalidUtf8: result.stderrInvalidUtf8 ?? false,
    } satisfies VcsProcessOutput;
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make).pipe(Layer.provide(ProcessRunner.layer));
