/**
 * Reading a provider's sign-in off this machine so an admin can share it
 * with their organization.
 *
 * Each provider CLI keeps its session somewhere of its own choosing; the
 * exporters here know where, read it verbatim, and describe it with a label
 * a person can recognise. The bytes go back to the admin's own client, which
 * stores them at the relay for the organization's executors to pick up. No
 * copy is kept here.
 *
 * @module provider/ProviderAccountExport
 */
import * as NodeOS from "node:os";

import {
  ServerProviderAccountExportError,
  type ProviderAccountPayload,
  type ProviderAccountProvider,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface ProviderAccountExport {
  readonly provider: ProviderAccountProvider;
  readonly label: string;
  readonly payload: ProviderAccountPayload;
}

export type ProviderAccountExporter = Effect.Effect<
  ProviderAccountExport,
  ServerProviderAccountExportError
>;

function exportError(input: {
  readonly instanceId: ProviderInstanceId;
  readonly reason: ServerProviderAccountExportError["reason"];
  readonly detail?: string;
  readonly cause?: unknown;
}) {
  return new ServerProviderAccountExportError({
    instanceId: input.instanceId,
    reason: input.reason,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

/** The one file a provider CLI keeps its session in, read as it lies. */
export const exportAuthStoreFile = Effect.fn("exportProviderAuthStoreFile")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderAccountProvider;
  readonly directory: string;
  readonly fileName: string;
  readonly describe: (content: string) => string;
  readonly signInHint: string;
}): Effect.fn.Return<
  ProviderAccountExport,
  ServerProviderAccountExportError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(input.directory, input.fileName);
  const exists = yield* fileSystem
    .exists(target)
    .pipe(
      Effect.mapError((cause) =>
        exportError({ instanceId: input.instanceId, reason: "read_failed", cause }),
      ),
    );
  if (!exists) {
    return yield* exportError({
      instanceId: input.instanceId,
      reason: "not_signed_in",
      detail: input.signInHint,
    });
  }
  const content = yield* fileSystem.readFileString(target).pipe(
    Effect.mapError((cause) =>
      exportError({
        instanceId: input.instanceId,
        reason: "read_failed",
        detail: `Could not read ${target}.`,
        cause,
      }),
    ),
  );
  return {
    provider: input.provider,
    label: input.describe(content),
    payload: { kind: "auth_store", files: [{ path: input.fileName, content }] },
  };
});

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The `email` claim of a JWT, without verifying it: this is a label, not a decision. */
function jwtEmail(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length < 2 || !segments[1]) return null;
  try {
    const payload = parseJsonRecord(Buffer.from(segments[1], "base64url").toString("utf8"));
    return typeof payload?.email === "string" && payload.email.length > 0 ? payload.email : null;
  } catch {
    return null;
  }
}

export const CODEX_AUTH_FILE = "auth.json";

/** `~/.codex/auth.json`: a ChatGPT sign-in (id token carries the email) or a stored API key. */
export function describeCodexAuthStore(content: string): string {
  const record = parseJsonRecord(content);
  if (record === null) return "Codex sign-in";
  if (typeof record.OPENAI_API_KEY === "string" && record.OPENAI_API_KEY.length > 0) {
    return "OpenAI API key";
  }
  const tokens = record.tokens;
  const email =
    tokens !== null && typeof tokens === "object"
      ? jwtEmail((tokens as Record<string, unknown>).id_token)
      : null;
  return email ?? "ChatGPT account";
}

export const CLAUDE_CREDENTIALS_FILE = ".credentials.json";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** `.credentials.json`: the subscription tier is the most a person can recognise it by. */
export function describeClaudeCredentials(content: string): string {
  const record = parseJsonRecord(content);
  const oauth = record?.claudeAiOauth;
  const subscription =
    oauth !== null && typeof oauth === "object"
      ? (oauth as Record<string, unknown>).subscriptionType
      : null;
  return typeof subscription === "string" && subscription.length > 0
    ? `Claude ${subscription}`
    : "Claude account";
}

/**
 * Claude Code keeps its session in `.credentials.json` under its config
 * directory on Linux, and in the login keychain on macOS. Executors are
 * Linux, so a keychain session is exported as the file they would read.
 */
export const exportClaudeCredentials = Effect.fn("exportClaudeCredentials")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly configDirectory: string;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): Effect.fn.Return<
  ProviderAccountExport,
  ServerProviderAccountExportError,
  FileSystem.FileSystem | Path.Path
> {
  const fromFile = exportAuthStoreFile({
    instanceId: input.instanceId,
    provider: "claudeAgent",
    directory: input.configDirectory,
    fileName: CLAUDE_CREDENTIALS_FILE,
    describe: describeClaudeCredentials,
    signInHint: "Sign in to Claude on this device first.",
  });
  if ((yield* HostProcessPlatform) !== "darwin") {
    return yield* fromFile;
  }
  return yield* fromFile.pipe(
    Effect.catchIf(
      (error) => error.reason === "not_signed_in",
      () => exportClaudeKeychainCredentials(input),
    ),
  );
});

const exportClaudeKeychainCredentials = Effect.fn("exportClaudeKeychainCredentials")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  }): Effect.fn.Return<ProviderAccountExport, ServerProviderAccountExportError> {
    const content = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* input.spawner.spawn(
          ChildProcess.make("security", [
            "find-generic-password",
            "-s",
            CLAUDE_KEYCHAIN_SERVICE,
            "-a",
            NodeOS.userInfo().username,
            "-w",
          ]),
        );
        const [stdout, exitCode] = yield* Effect.all([
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.exitCode,
        ]);
        return Number(exitCode) === 0 ? stdout.trim() : null;
      }),
    ).pipe(
      Effect.mapError((cause) =>
        exportError({
          instanceId: input.instanceId,
          reason: "read_failed",
          detail: "Could not read the Claude session from the login keychain.",
          cause,
        }),
      ),
    );
    if (content === null || content.length === 0) {
      return yield* exportError({
        instanceId: input.instanceId,
        reason: "not_signed_in",
        detail: "Sign in to Claude on this device first.",
      });
    }
    return {
      provider: "claudeAgent",
      label: describeClaudeCredentials(content),
      payload: { kind: "auth_store", files: [{ path: CLAUDE_CREDENTIALS_FILE, content }] },
    };
  },
);

export const OPENCODE_AUTH_FILE = "auth.json";

/** Where OpenCode keeps `auth.json`: its XDG data directory. */
export function resolveOpenCodeDataDirectory(
  path: Path.Path,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const dataHome =
    environment.XDG_DATA_HOME && environment.XDG_DATA_HOME.trim().length > 0
      ? environment.XDG_DATA_HOME
      : path.join(NodeOS.homedir(), ".local", "share");
  return path.join(dataHome, "opencode");
}

/** OpenCode's `auth.json` is keyed by provider; the keys are the label. */
export function describeOpenCodeAuthStore(content: string): string {
  const record = parseJsonRecord(content);
  const providers = record === null ? [] : Object.keys(record);
  return providers.length > 0 ? `OpenCode: ${providers.join(", ")}` : "OpenCode sign-in";
}
