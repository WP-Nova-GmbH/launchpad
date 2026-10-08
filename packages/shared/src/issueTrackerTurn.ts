import { ClientOrchestrationCommand } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";

const encode = Schema.encodeSync(Schema.fromJsonString(ClientOrchestrationCommand));
export function stripIssueTrackerAuthorization(
  command: ClientOrchestrationCommand,
): ClientOrchestrationCommand {
  if (!("issueTrackerAuthorization" in command)) return command;
  const { issueTrackerAuthorization: _credential, ...plain } = command;
  return plain;
}
/** Canonicalize using the wire schema before server normalization; exclude the transport credential. */
export const issueTrackerCommandDigest = Effect.fnUntraced(function* (
  command: ClientOrchestrationCommand,
) {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto
    .digest("SHA-256", new TextEncoder().encode(encode(stripIssueTrackerAuthorization(command))))
    .pipe(Effect.map(Encoding.encodeHex));
});
