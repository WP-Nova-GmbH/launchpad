// @effect-diagnostics nodeBuiltinImport:off - The SDK requires a synchronous native spawn callback.
import * as NodeChildProcess from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ProviderDriverKind, type ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProviderAdapterProcessError } from "../Errors.ts";

export interface ClaudeNativeProcess {
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  readonly stop: Effect.Effect<void, ProviderAdapterProcessError>;
  readonly wasSpawnAttempted: () => boolean;
}

const missingProcess = Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }));

/** Keep native exit evidence separate from the SDK's bounded cleanup promise. */
export const makeClaudeNativeProcess = Effect.fn("makeClaudeNativeProcess")(function* (
  threadId: ThreadId,
  options?: {
    readonly spawn?: (options: SpawnOptions) => NodeChildProcess.ChildProcessWithoutNullStreams;
    readonly stderr?: (text: string) => void;
  },
) {
  const platform = yield* HostProcessPlatform;
  const exited = yield* Deferred.make<void>();
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let attempted = false;
  let acquisitionFailed = false;
  let sealed = false;
  let nativeConfirmed = false;
  let windowsTreeStopped = false;
  const failure = (cause: unknown) =>
    new ProviderAdapterProcessError({
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId,
      detail: "The original Claude process tree could not be confirmed stopped.",
      cause,
    });
  const running = () => child !== undefined && child.exitCode === null && child.signalCode === null;
  const signalGroup = (signal: NodeJS.Signals) =>
    Effect.try({
      try: () => {
        process.kill(-Number(child!.pid), signal);
      },
      catch: failure,
    });
  const waitForExit = Deferred.await(exited).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(failure("No native exit was delivered after termination.")),
    }),
  );
  const stop = Effect.fn("ClaudeNativeProcess.stop")(function* () {
    sealed = true;
    if (nativeConfirmed) return;
    if (!attempted) {
      nativeConfirmed = true;
      return;
    }
    if (acquisitionFailed) {
      nativeConfirmed = true;
      return;
    }
    if (!child?.pid)
      return yield* failure("Native acquisition did not retain a usable child handle.");
    if (platform === "win32") {
      if (!windowsTreeStopped) {
        if (!running()) return yield* failure("The original native tree ownership was lost.");
        yield* Effect.callback<void, ProviderAdapterProcessError>((resume) => {
          NodeChildProcess.execFile(
            "taskkill",
            ["/pid", String(child!.pid), "/t", "/f"],
            { windowsHide: true, timeout: 3_000 },
            (error) => resume(error ? Effect.fail(failure(error)) : Effect.void),
          );
        });
        windowsTreeStopped = true;
      }
      yield* waitForExit;
    } else {
      if (running()) {
        yield* signalGroup("SIGTERM");
        const stopped = yield* Deferred.await(exited).pipe(Effect.timeoutOption("2 seconds"));
        if (Option.isNone(stopped)) {
          if (!running()) return yield* failure("Native exit evidence is unavailable.");
          yield* signalGroup("SIGKILL");
          yield* waitForExit;
        }
      } else yield* waitForExit;
      const absent = yield* Effect.try({
        try: () => {
          try {
            process.kill(-Number(child!.pid), 0);
            return false;
          } catch (cause) {
            if (missingProcess(cause)) return true;
            throw cause;
          }
        },
        catch: failure,
      });
      if (!absent) return yield* failure("The owned native process group is still present.");
    }
    if (running()) return yield* failure("The original native child is still running.");
    nativeConfirmed = true;
  });
  return {
    spawn: (input) => {
      if (sealed || attempted) throw new Error("Claude native acquisition is already closed.");
      attempted = true;
      child = options?.spawn
        ? options.spawn(input)
        : NodeChildProcess.spawn(input.command, input.args, {
            cwd: input.cwd,
            env: input.env,
            signal: input.signal,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: platform !== "win32",
          });
      child.once("exit", () => Deferred.doneUnsafe(exited, Effect.void));
      child.once("error", () => {
        // A reported spawn error without a PID establishes that no native process was acquired.
        if (!child?.pid) acquisitionFailed = true;
      });
      // Keep stderr flowing even when the SDK uses the custom spawn path.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) => options?.stderr?.(text));
      child.stderr.on("error", () => {});
      return child;
    },
    stop: stop(),
    wasSpawnAttempted: () => attempted,
  } satisfies ClaudeNativeProcess;
});
