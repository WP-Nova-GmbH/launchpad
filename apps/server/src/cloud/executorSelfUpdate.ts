/**
 * Keeping an executor's own source current.
 *
 * A managed executor runs Launchpad from a source checkout and nobody logs in
 * to update it. So an enrolled agent executor asks the relay which source and
 * ref it should be on, fetches that ref through the organization's GitHub
 * credential, and when the head has moved resets its checkout to it,
 * reinstalls dependencies, and exits — the service manager restarts it on the
 * new code. A plain source snapshot without `.git` is turned into a checkout
 * in place the first time. Personal machines, bundled installs, and anything
 * with `T3CODE_EXECUTOR_SELF_UPDATE=0` are never touched.
 *
 * @module cloud/executorSelfUpdate
 */
import * as NodeURL from "node:url";

import type { VcsError } from "@t3tools/contracts";
import { RelayApi } from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { readManagedExecutorRelayConfig } from "./machineEnrollment.ts";

export const EXECUTOR_SELF_UPDATE_ENV = "T3CODE_EXECUTOR_SELF_UPDATE";
/** The file that marks the root of a Launchpad source checkout. */
const SOURCE_ROOT_MARKER = "pnpm-workspace.yaml";
/** How git learns the organization's installation token (ADR-0015), as the clone path does. */
const GITHUB_CREDENTIAL_HELPER = "!gh auth git-credential";
const OPERATION = "executor-self-update";

export interface ExecutorRelease {
  readonly gitUrl: string;
  readonly ref: string;
}

export type ExecutorSelfUpdateOutcome =
  | "disabled"
  | "not_executor"
  | "not_source_checkout"
  | "not_configured"
  | "current"
  | "updated"
  | "failed";

/** Walk up from a directory to the checkout that contains it, or null outside one. */
export const findSourceCheckoutRoot = Effect.fn("findSourceCheckoutRoot")(function* (
  startDirectory: string,
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(startDirectory);
  for (;;) {
    const marked = yield* fileSystem
      .exists(path.join(current, SOURCE_ROOT_MARKER))
      .pipe(Effect.orElseSucceed(() => false));
    if (marked) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
});

/**
 * Bring a checkout to the release's ref. "current" when the head already
 * matches; "updated" after a reset and reinstall, at which point the running
 * process is stale and should exit.
 */
export const syncSourceCheckout = Effect.fn("syncExecutorSourceCheckout")(function* (input: {
  readonly sourceRoot: string;
  readonly release: ExecutorRelease;
}): Effect.fn.Return<
  "current" | "updated",
  VcsError,
  VcsProcess.VcsProcess | FileSystem.FileSystem | Path.Path
> {
  const vcs = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (
    args: ReadonlyArray<string>,
    options?: { readonly allowNonZeroExit?: boolean; readonly timeoutMs?: number },
  ) =>
    vcs.run({
      operation: OPERATION,
      command: "git",
      args,
      cwd: input.sourceRoot,
      ...(options?.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

  // A snapshot shipped without history becomes a checkout in place; an
  // existing checkout is pointed at the release's remote.
  const isCheckout = yield* fileSystem
    .exists(path.join(input.sourceRoot, ".git"))
    .pipe(Effect.orElseSucceed(() => false));
  if (!isCheckout) {
    yield* git(["init", "--quiet"]);
    yield* git(["remote", "add", "origin", input.release.gitUrl]);
  } else {
    const remote = yield* git(["remote", "get-url", "origin"], { allowNonZeroExit: true });
    if (Number(remote.exitCode) !== 0) {
      yield* git(["remote", "add", "origin", input.release.gitUrl]);
    } else if (remote.stdout.trim() !== input.release.gitUrl) {
      yield* git(["remote", "set-url", "origin", input.release.gitUrl]);
    }
  }

  yield* git(
    [
      "-c",
      `credential.helper=${GITHUB_CREDENTIAL_HELPER}`,
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "origin",
      input.release.ref,
    ],
    { timeoutMs: 5 * 60_000 },
  );
  const local = yield* git(["rev-parse", "--verify", "--quiet", "HEAD"], {
    allowNonZeroExit: true,
  });
  const fetched = yield* git(["rev-parse", "FETCH_HEAD"]);
  if (Number(local.exitCode) === 0 && local.stdout.trim() === fetched.stdout.trim()) {
    return "current";
  }

  // `reset --hard` only touches tracked files: untracked state such as
  // node_modules and agent directories inside the checkout survives.
  yield* git(["reset", "--hard", "--quiet", "FETCH_HEAD"]);
  yield* vcs.run({
    operation: OPERATION,
    command: "pnpm",
    args: ["install", "--frozen-lockfile"],
    cwd: input.sourceRoot,
    timeoutMs: 15 * 60_000,
    maxOutputBytes: 5_000_000,
  });
  return "updated";
});

/**
 * One pass: find out where this process runs from, ask the relay what it
 * should be running, and sync. Never fails; every outcome is logged. On
 * "updated" the process exits so the service manager restarts it.
 */
export const ensureExecutorSourceCurrent = Effect.fn("ensureExecutorSourceCurrent")(
  function* (): Effect.fn.Return<
    ExecutorSelfUpdateOutcome,
    never,
    | ServerSecretStore.ServerSecretStore
    | ServerEnvironment.ServerEnvironment
    | VcsProcess.VcsProcess
    | HttpClient.HttpClient
    | FileSystem.FileSystem
    | Path.Path
  > {
    if (process.env[EXECUTOR_SELF_UPDATE_ENV]?.trim() === "0") {
      return "disabled";
    }
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const relayConfig = yield* readManagedExecutorRelayConfig(secrets);
    if (relayConfig === null) {
      return "not_executor";
    }
    const sourceRoot = yield* findSourceCheckoutRoot(
      NodeURL.fileURLToPath(new URL(".", import.meta.url)),
    );
    if (sourceRoot === null) {
      yield* Effect.logInfo("executor self-update skipped; not running from a source checkout");
      return "not_source_checkout";
    }

    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    const release = yield* Effect.gen(function* () {
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const relayClient = yield* HttpApiClient.make(RelayApi, {
        baseUrl: relayConfig.url,
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeader(
            "authorization",
            `Bearer ${relayConfig.environmentCredential}`,
          ),
        ),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      return yield* relayClient.executorReleaseServer.getExecutorRelease({
        params: { environmentId },
      });
    }).pipe(
      Effect.map((response): ExecutorRelease | "not_configured" => response),
      Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed("not_configured" as const)),
      Effect.catchCause((cause) =>
        Effect.logWarning("executor release request failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as("failed" as const),
        ),
      ),
      withRelayClientTracing,
    );
    if (release === "not_configured" || release === "failed") {
      return release;
    }

    const outcome = yield* syncSourceCheckout({ sourceRoot, release }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("executor self-update failed", {
          sourceRoot,
          ref: release.ref,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as("failed" as const)),
      ),
    );
    if (outcome === "updated") {
      yield* Effect.logInfo("executor source updated; exiting for the service manager to restart", {
        sourceRoot,
        gitUrl: release.gitUrl,
        ref: release.ref,
      });
      yield* Effect.sync(() => process.exit(0));
    }
    return outcome;
  },
);
