import { RelayThreadVmEnrollmentReceipt } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const encode = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmEnrollmentReceipt));
/** A launch receipt binds the installed enrollment; it never grants execution. */
export const threadVmMoveServerDigest = Effect.fnUntraced(function* (
  receipt: RelayThreadVmEnrollmentReceipt,
) {
  const bytes = yield* (yield* Crypto.Crypto).digest(
    "SHA-256",
    new TextEncoder().encode(yield* encode(receipt)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
});
