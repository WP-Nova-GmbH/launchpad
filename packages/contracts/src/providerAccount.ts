import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * The providers an organization can hold an account for. Grok is absent: its
 * CLI has no sign-in the app can capture and no key it reads from the
 * environment that Launchpad knows how to place.
 */
export const ProviderAccountProvider = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
]);
export type ProviderAccountProvider = typeof ProviderAccountProvider.Type;

export const PROVIDER_ACCOUNT_LABEL_MAX_LENGTH = 200;
export const PROVIDER_ACCOUNT_FILE_MAX_LENGTH = 64 * 1024;
export const PROVIDER_ACCOUNT_MAX_FILES = 8;

/** Relative to the provider's home on the executor; never a directory escape. */
export const ProviderAccountFilePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/),
  Schema.isPattern(/^(?!.*(^|\/)\.\.(\/|$))/),
);

export const ProviderAccountFile = Schema.Struct({
  path: ProviderAccountFilePath,
  content: Schema.String.check(Schema.isMaxLength(PROVIDER_ACCOUNT_FILE_MAX_LENGTH)),
});
export type ProviderAccountFile = typeof ProviderAccountFile.Type;

/**
 * What an organization account for a provider consists of: either one
 * environment variable the provider CLI reads (an API key or long-lived
 * token), or the provider CLI's own auth store, copied file for file.
 */
export const ProviderAccountPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("env"),
    name: TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{1,63}$/)),
    value: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_ACCOUNT_FILE_MAX_LENGTH)),
  }),
  Schema.Struct({
    kind: Schema.Literal("auth_store"),
    files: Schema.Array(ProviderAccountFile).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PROVIDER_ACCOUNT_MAX_FILES),
    ),
  }),
]);
export type ProviderAccountPayload = typeof ProviderAccountPayload.Type;

export const ProviderAccountKind = Schema.Literals(["env", "auth_store"]);
export type ProviderAccountKind = typeof ProviderAccountKind.Type;

/**
 * A provider account as captured from a signed-in environment, ready to be
 * stored for the organization. Returned by `server.exportProviderAccount`.
 */
export const ServerProviderAccountExport = Schema.Struct({
  provider: ProviderAccountProvider,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_ACCOUNT_LABEL_MAX_LENGTH)),
  payload: ProviderAccountPayload,
});
export type ServerProviderAccountExport = typeof ServerProviderAccountExport.Type;

export const ServerProviderAccountExportInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ServerProviderAccountExportInput = typeof ServerProviderAccountExportInput.Type;

export class ServerProviderAccountExportError extends Schema.TaggedErrorClass<ServerProviderAccountExportError>()(
  "ServerProviderAccountExportError",
  {
    instanceId: ProviderInstanceId,
    reason: Schema.Literals(["instance_not_found", "unsupported", "not_signed_in", "read_failed"]),
    detail: Schema.optionalKey(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail ? `: ${this.detail}` : "";
    return `Provider account export failed for ${this.instanceId} (${this.reason})${detail}`;
  }
}
