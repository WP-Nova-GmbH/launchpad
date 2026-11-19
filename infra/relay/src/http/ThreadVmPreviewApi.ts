import { ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import { RelayDb } from "../db.ts";
import { authorizeThreadVmConnection } from "../threads/ThreadVmConnectionAccess.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { makeThreadVmPreviewStore } from "../threads/ThreadVmPreviewStore.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { tenancyNotFound } from "./tenancyErrors.ts";

export const previewSecretHash = Effect.fnUntraced(function* (secret: string) {
  const crypto = yield* Crypto.Crypto;
  return Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(secret)));
});
export const newPreviewSecret = Effect.fnUntraced(function* () {
  const crypto = yield* Crypto.Crypto;
  return Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
});
export const previewOrigin = (baseUrl: string, previewId: string) => {
  const origin = new URL(baseUrl);
  origin.hostname = `${previewId}.${origin.hostname}`;
  return origin.origin;
};
/** Explicit port selection never wakes compute and never returns E2B routing credentials. */
export const openThreadVmPreview = Effect.fn("relay.api.thread_vm.open_preview")(
  function* (threadId: ThreadId, port: number) {
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    if (!settings?.previewBaseUrl) return yield* relayInternalErrorResponse("upstream_unavailable");
    const { userId } = yield* RelayClientPrincipal;
    const target = yield* authorizeThreadVmConnection(userId, threadId);
    const crypto = yield* Crypto.Crypto,
      previewId = (yield* crypto.randomUUIDv4).replaceAll("-", ""),
      secret = yield* newPreviewSecret();
    yield* makeThreadVmPreviewStore((yield* RelayDb).$client).issue({
      previewId,
      userId,
      threadId,
      port,
      allocationId: target.identity.scope.allocationId,
      generation: target.identity.scope.generation,
      ticketSha256: yield* previewSecretHash(secret),
    });
    // A concurrent move/revocation must not release a newly minted link.
    const current = yield* authorizeThreadVmConnection(userId, threadId);
    if (
      current.identity.scope.allocationId !== target.identity.scope.allocationId ||
      current.identity.scope.generation !== target.identity.scope.generation
    )
      return yield* tenancyNotFound("thread_not_found");
    return {
      url: `${previewOrigin(settings.previewBaseUrl, previewId)}/__launchpad_preview/#${secret}`,
    };
  },
  Effect.catchTags({
    ThreadVmConnectionUnavailable: () => tenancyNotFound("thread_not_found"),
    ThreadVmPreviewDenied: () => relayInternalErrorResponse("upstream_unavailable"),
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    PlatformError: () => relayInternalErrorResponse("internal_error"),
  }),
);
