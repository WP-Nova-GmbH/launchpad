import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

const BridgeId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const State = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const CodexVmSignInBridge = Schema.Struct({
  bridgeId: BridgeId,
  state: State,
  redirectUri: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type CodexVmSignInBridge = typeof CodexVmSignInBridge.Type;

export const CodexVmSignInBridgeInput = Schema.Struct({ bridgeId: BridgeId });

/** Only these callback fields may leave the temporary loopback listener. */
export const CodexVmSignInCallback = Schema.Struct({
  state: State,
  code: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  clientId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  error: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type CodexVmSignInCallback = typeof CodexVmSignInCallback.Type;

export class CodexVmSignInError extends Schema.TaggedError<CodexVmSignInError>()(
  "CodexVmSignInError",
  {
    reason: Schema.Literals([
      "unsupported_surface",
      "unavailable",
      "expired",
      "cancelled",
      "not_found",
    ]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "unsupported_surface":
        return "Connect Codex from Launchpad desktop or a browser on the computer running Launchpad.";
      case "expired":
        return "Codex sign-in expired. Start again.";
      case "cancelled":
        return "Codex sign-in was cancelled.";
      case "not_found":
        return "This Codex sign-in belongs to another connection or has ended. Start again.";
      case "unavailable":
        return "Could not open the local Codex sign-in callback. Start again.";
    }
  }
}
