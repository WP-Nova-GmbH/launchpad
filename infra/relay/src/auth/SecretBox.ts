import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

export class SecretBoxError extends Schema.TaggedErrorClass<SecretBoxError>()("SecretBoxError", {
  operation: Schema.Literals(["seal", "open"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Secret box '${this.operation}' failed`;
  }
}

/**
 * Seals the few secrets the relay itself has to keep in Postgres — today the
 * GitHub App private key created from Organization settings — so a database
 * copy on its own reveals nothing. The key is derived from the relay's cloud
 * mint private key, which already lives only in relay configuration; no new
 * secret to provision or rotate. AES-GCM with a fresh nonce per seal.
 */
export class RelaySecretBox extends Context.Service<
  RelaySecretBox,
  {
    readonly seal: (plaintext: string) => Effect.Effect<string, SecretBoxError>;
    readonly open: (sealed: string) => Effect.Effect<string, SecretBoxError>;
  }
>()("t3code-relay/auth/RelaySecretBox") {}

const VERSION = "v1";
const NONCE_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const key = yield* Effect.promise(async () => {
    const material = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(Redacted.value(config.cloudMintPrivateKey)),
    );
    return globalThis.crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  });

  return RelaySecretBox.of({
    seal: (plaintext) =>
      Effect.tryPromise({
        try: async () => {
          const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
          const ciphertext = new Uint8Array(
            await globalThis.crypto.subtle.encrypt(
              { name: "AES-GCM", iv: nonce },
              key,
              new TextEncoder().encode(plaintext),
            ),
          );
          return `${VERSION}.${toBase64Url(nonce)}.${toBase64Url(ciphertext)}`;
        },
        catch: (cause) => new SecretBoxError({ operation: "seal", cause }),
      }),
    open: (sealed) =>
      Effect.tryPromise({
        try: async () => {
          const [version, nonce, ciphertext] = sealed.split(".");
          if (version !== VERSION || !nonce || !ciphertext) {
            throw new Error("unrecognised sealed format");
          }
          const plaintext = await globalThis.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64Url(nonce) },
            key,
            fromBase64Url(ciphertext),
          );
          return new TextDecoder().decode(plaintext);
        },
        catch: (cause) => new SecretBoxError({ operation: "open", cause }),
      }),
  });
});

export const layer = Layer.effect(RelaySecretBox, make);
