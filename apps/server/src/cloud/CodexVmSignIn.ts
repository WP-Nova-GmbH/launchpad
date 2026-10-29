// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer requires the native listener constructor.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  CodexVmSignInError,
  type CodexVmSignInBridge,
  type CodexVmSignInCallback,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

const CALLBACK_LIFETIME_MS = 10 * 60_000;
const isCodexVmSignInError = Schema.is(CodexVmSignInError);
const loopback = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);

/** A callback on this server is useful only when the client browser shares its loopback host. */
export function supportsCodexVmSignIn(input: {
  readonly origin?: string | undefined;
  readonly host?: string | undefined;
  readonly remoteAddress?: string | undefined;
  readonly forwarded: boolean;
}) {
  if (
    input.forwarded ||
    !input.remoteAddress ||
    !loopback(input.remoteAddress.replace(/^::ffff:/u, "")) ||
    !input.host ||
    !input.origin
  )
    return false;
  try {
    if (!loopback(new URL(`http://${input.host}`).hostname)) return false;
    if (["t3code://app", "t3code-dev://app"].includes(input.origin)) return true;
    const origin = new URL(input.origin);
    return (
      ["http:", "https:"].includes(origin.protocol) &&
      loopback(origin.hostname) &&
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash
    );
  } catch {
    return false;
  }
}

/** Invalid callbacks leave the listener waiting for the real authorization response. */
export function parseCodexVmSignInCallback(
  method: string,
  target: string,
  expectedState: string,
): CodexVmSignInCallback | null {
  if (method !== "GET" || target.length > 20_000 || !target.startsWith("/auth/callback?"))
    return null;
  try {
    const url = new URL(target, "http://127.0.0.1");
    if (url.pathname !== "/auth/callback" || url.hash) return null;
    const values = new Map<string, string>();
    for (const [name, value] of url.searchParams) {
      if (values.has(name)) return null;
      values.set(name, value);
    }
    const state = values.get("state"),
      code = values.get("code"),
      clientId = values.get("client_id"),
      error = values.get("error");
    const valid = (value: string | undefined, max: number) =>
      value === undefined ||
      (value.length > 0 &&
        value.length <= max &&
        !Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }));
    if (
      state !== expectedState ||
      (!code && !error) ||
      (code !== undefined && error !== undefined) ||
      !valid(code, 8192) ||
      !valid(clientId, 256) ||
      !valid(error, 128)
    )
      return null;
    return {
      state,
      ...(code ? { code } : {}),
      ...(clientId ? { clientId } : {}),
      ...(error ? { error } : {}),
    };
  } catch {
    return null;
  }
}

interface Attempt {
  readonly bridge: CodexVmSignInBridge;
  readonly scope: Scope.Closeable;
  readonly callback: Deferred.Deferred<CodexVmSignInCallback, CodexVmSignInError>;
  finished: boolean;
}

/** One ephemeral listener per authenticated WebSocket connection. No OAuth tokens are stored here. */
export const makeCodexVmSignIn = Effect.fnUntraced(function* (supported: boolean) {
  const ownerScope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  let current: Attempt | null = null;
  const finish = (attempt: Attempt, result: Exit.Exit<CodexVmSignInCallback, CodexVmSignInError>) =>
    Effect.gen(function* () {
      if (attempt.finished) return;
      attempt.finished = true;
      yield* Deferred.done(attempt.callback, result);
      // Closing after the handler returns lets Node send the callback response first.
      yield* Scope.close(attempt.scope, Exit.void).pipe(Effect.forkIn(ownerScope));
    });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (!current) return;
      current.finished = true;
      yield* Deferred.fail(current.callback, new CodexVmSignInError({ reason: "cancelled" }));
      yield* Scope.close(current.scope, Exit.void);
      current = null;
    }),
  );
  const requireAttempt = (bridgeId: string) =>
    Effect.gen(function* () {
      if (!current || current.bridge.bridgeId !== bridgeId)
        return yield* new CodexVmSignInError({ reason: "not_found" });
      return current;
    });
  return {
    supported,
    start: lock.withPermit(
      Effect.gen(function* () {
        if (!supported) return yield* new CodexVmSignInError({ reason: "unsupported_surface" });
        if (current)
          yield* finish(current, Exit.fail(new CodexVmSignInError({ reason: "cancelled" })));
        const callback = yield* Deferred.make<CodexVmSignInCallback, CodexVmSignInError>();
        const state = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
        const bridgeId = yield* crypto.randomUUIDv4;
        const now = (yield* DateTime.now).epochMilliseconds;
        const scope = yield* Scope.fork(ownerScope);
        const server = yield* NodeHttpServer.make(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
          disablePreemptiveShutdown: true,
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
          Effect.mapError(() => new CodexVmSignInError({ reason: "unavailable" })),
        );
        if (typeof server.address === "string" || !("port" in server.address)) {
          yield* Scope.close(scope, Exit.void);
          return yield* new CodexVmSignInError({ reason: "unavailable" });
        }
        const bridge: CodexVmSignInBridge = {
          bridgeId,
          state,
          redirectUri: `http://127.0.0.1:${server.address.port}/auth/callback`,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + CALLBACK_LIFETIME_MS)),
        };
        const attempt: Attempt = { bridge, scope, callback, finished: false };
        current = attempt;
        yield* server
          .serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const payload = parseCodexVmSignInCallback(
                request.method,
                request.originalUrl,
                state,
              );
              if (
                current !== attempt ||
                attempt.finished ||
                !payload ||
                (yield* DateTime.now).epochMilliseconds >= now + CALLBACK_LIFETIME_MS
              )
                return HttpServerResponse.text("Invalid or expired Codex sign-in callback.", {
                  status: 400,
                });
              yield* finish(attempt, Exit.succeed(payload));
              return HttpServerResponse.text("Codex sign-in received. Return to Launchpad.", {
                headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
              });
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));
        yield* Effect.sleep(CALLBACK_LIFETIME_MS).pipe(
          Effect.andThen(finish(attempt, Exit.fail(new CodexVmSignInError({ reason: "expired" })))),
          Effect.forkIn(scope),
        );
        return bridge;
      }).pipe(
        Effect.uninterruptible,
        Effect.mapError((error) =>
          isCodexVmSignInError(error) ? error : new CodexVmSignInError({ reason: "unavailable" }),
        ),
      ),
    ),
    wait: (bridgeId: string) =>
      requireAttempt(bridgeId).pipe(Effect.flatMap((attempt) => Deferred.await(attempt.callback))),
    cancel: (bridgeId: string) =>
      lock.withPermit(
        requireAttempt(bridgeId).pipe(
          Effect.flatMap((attempt) =>
            finish(attempt, Exit.fail(new CodexVmSignInError({ reason: "cancelled" }))),
          ),
        ),
      ),
  };
});
