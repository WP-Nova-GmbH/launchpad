import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CodexVmConnectionFailureReason = Schema.Literals([
  "invalid_request",
  "access_denied",
  "identity_mismatch",
  "invalid_token",
  "missing_scope",
  "invalid_grant",
  "configuration",
  "uncertain",
  "unavailable",
  "stale_attempt",
  "not_connected",
  "organization_managed",
  "source_unavailable",
  "vm_update_required",
]);
export class CodexVmConnectionError extends Schema.TaggedError<CodexVmConnectionError>()(
  "CodexVmConnectionError",
  {
    reason: CodexVmConnectionFailureReason,
    revocationUnconfirmed: Schema.optionalKey(Schema.Boolean),
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    const messages = {
      invalid_request: "The Codex sign-in request is invalid. Start again.",
      access_denied: "Codex sign-in was cancelled or access was denied.",
      identity_mismatch: "This is a different ChatGPT account. Use Replace account to change it.",
      invalid_token: "The ChatGPT sign-in could not be verified. Start again.",
      missing_scope: "ChatGPT plan usage was not enabled. Reconnect and allow plan usage.",
      invalid_grant:
        "The ChatGPT session expired or was revoked. Reconnect in Organization settings.",
      configuration: "The Codex connection could not be validated. Check the server configuration.",
      uncertain:
        "The ChatGPT renewal result could not be confirmed. Reconnect in Organization settings.",
      unavailable: "The Codex sign-in service is temporarily unavailable. Try again.",
      stale_attempt: "This sign-in was superseded or expired. Start again.",
      not_connected:
        "Connect Codex for VMs in Organization settings, then select that connection again.",
      organization_managed:
        "This VM uses the organization's Codex account. Change the account source during VM preparation.",
      source_unavailable:
        "This VM's account selection is unavailable. Choose an account source to finish VM preparation.",
      vm_update_required:
        "This VM has not confirmed organization Codex support. Update or recreate the VM with the current template, then retry preparation.",
    };
    return (
      messages[this.reason] +
      (this.revocationUnconfirmed
        ? " Previous session revocation could not be confirmed. Review Launchpad in ChatGPT Settings."
        : "")
    );
  }
}

/** Connection metadata only. Renewable credentials belong exclusively to the relay. */
export const RelayCodexVmConnection = Schema.Struct({
  connectionId: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.NullOr(Schema.String),
  status: Schema.Literals(["disconnected", "connected", "reconnect_required"]),
  epoch: NonNegativeInt,
  tokenRevision: NonNegativeInt,
  errorCode: Schema.NullOr(
    Schema.Literals([
      "refresh_uncertain",
      "invalid_grant",
      "configuration_error",
      "revocation_unconfirmed",
    ]),
  ),
  refreshing: Schema.Boolean,
  revocationUnconfirmed: Schema.optionalKey(Schema.Boolean),
});
export type RelayCodexVmConnection = typeof RelayCodexVmConnection.Type;

export const RelayThreadVmCodexAuthSelection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("personal") }),
  Schema.Struct({ mode: Schema.Literal("organization"), connectionId: TrimmedNonEmptyString }),
]);
export type RelayThreadVmCodexAuthSelection = typeof RelayThreadVmCodexAuthSelection.Type;
export const RelayThreadVmCodexAuthSource = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("personal") }),
  Schema.Struct({
    mode: Schema.Literal("organization"),
    connectionId: TrimmedNonEmptyString,
    connection: RelayCodexVmConnection,
  }),
]);
export type RelayThreadVmCodexAuthSource = typeof RelayThreadVmCodexAuthSource.Type;

export const RelayCodexVmSignInIntent = Schema.Literals(["connect", "reconnect", "replace"]);
export const RelayCodexVmStartSignIn = Schema.Struct({
  state: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43,128}$/)),
  redirectUri: TrimmedNonEmptyString,
  intent: RelayCodexVmSignInIntent,
  retryAttemptId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayCodexVmStartSignIn = typeof RelayCodexVmStartSignIn.Type;
export const RelayCodexVmCompleteSignIn = Schema.Struct({
  attemptId: TrimmedNonEmptyString,
  state: Schema.String.check(Schema.isMaxLength(128)),
  code: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192))),
  clientId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
export type RelayCodexVmCompleteSignIn = typeof RelayCodexVmCompleteSignIn.Type;
export const RelayCodexVmSignInAttempt = Schema.Struct({
  attemptId: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  phase: Schema.Literals([
    "pending",
    "exchanging",
    "completed",
    "cancelled",
    "denied",
    "expired",
    "failed",
    "superseded",
  ]),
});
export type RelayCodexVmSignInAttempt = typeof RelayCodexVmSignInAttempt.Type;
export const RelayCodexVmStartSignInResponse = Schema.Struct({
  attempt: RelayCodexVmSignInAttempt,
  authorizationUrl: TrimmedNonEmptyString,
});
export type RelayCodexVmStartSignInResponse = typeof RelayCodexVmStartSignInResponse.Type;

export const RelayCodexVmToken = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    connectionId: TrimmedNonEmptyString,
    label: Schema.String,
    epoch: NonNegativeInt,
    tokenRevision: NonNegativeInt,
    token: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    retryAfterMs: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 1000 }),
    ),
  }),
]);
export type RelayCodexVmToken = typeof RelayCodexVmToken.Type;
