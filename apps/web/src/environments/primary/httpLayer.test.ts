import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { __resetDesktopPrimaryAuthForTests } from "./desktopAuth";
import { makePrimaryEnvironmentHttpLayer } from "./httpLayer";

describe.sequential("primary environment HTTP layer", () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.effect("uses cookie credentials for browser primary environments", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:3773/settings",
          origin: "http://127.0.0.1:3773",
        },
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/auth/session");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).toBe("same-origin");
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it.effect("does not opt relay requests into cross-origin cookies", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:3773/settings",
          origin: "http://127.0.0.1:3773",
        },
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.post("https://relay.example/v1/client/environment-link-challenges", {
        headers: { authorization: "Bearer cloud-session" },
      });
      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).toBe("same-origin");
      expect(new URL(request.url).origin).not.toBe("http://127.0.0.1:3773");
      expect(request.headers.get("authorization")).toBe("Bearer cloud-session");
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  describe("browser opened on the desktop dev frontend", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5996");
      vi.stubEnv("VITE_HTTP_URL", "http://127.0.0.1:14036");
      vi.stubEnv("VITE_WS_URL", "ws://127.0.0.1:14036");
      vi.stubGlobal("window", {
        location: new URL("http://127.0.0.1:5996/settings"),
      });
    });

    it.effect("sends paired cookies to the explicit primary link endpoints", () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      return Effect.gen(function* () {
        yield* HttpClient.get("http://127.0.0.1:14036/api/connect/link-state");
        yield* HttpClient.post("http://127.0.0.1:14036/api/connect/link-proof");

        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const [index, endpoint] of ["link-state", "link-proof"].entries()) {
          const request = new Request(
            fetchMock.mock.calls[index]?.[0],
            fetchMock.mock.calls[index]?.[1],
          );
          expect(request.url).toBe(`http://127.0.0.1:14036/api/connect/${endpoint}`);
          expect(request.credentials).toBe("include");
          expect(request.headers.get("authorization")).toBeNull();
        }
      }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
    });

    it.effect(
      "keeps proxy, relay and other loopback requests outside primary cookie access",
      () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        return Effect.gen(function* () {
          yield* HttpClient.post("https://relay.example/v1/client/environment-link-challenges", {
            headers: { authorization: "Bearer cloud-session" },
          });
          yield* HttpClient.get("http://127.0.0.1:14037/api/connect/link-state");
          yield* HttpClient.get("http://127.0.0.1:5996/api/auth/session");

          expect(fetchMock).toHaveBeenCalledTimes(3);
          for (const [url, init] of fetchMock.mock.calls) {
            const request = new Request(url, init);
            expect(request.credentials).not.toBe("include");
          }
          const relayRequest = new Request(
            fetchMock.mock.calls[0]?.[0],
            fetchMock.mock.calls[0]?.[1],
          );
          expect(relayRequest.headers.get("authorization")).toBe("Bearer cloud-session");
          const proxyRequest = new Request(
            fetchMock.mock.calls[2]?.[0],
            fetchMock.mock.calls[2]?.[1],
          );
          expect(proxyRequest.credentials).toBe("same-origin");
        }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
      },
    );

    for (const { boundary, httpBaseUrl, wsBaseUrl } of [
      {
        boundary: "hostname",
        httpBaseUrl: "http://localhost:14036",
        wsBaseUrl: "ws://localhost:14036",
      },
      {
        boundary: "scheme",
        httpBaseUrl: "https://127.0.0.1:14036",
        wsBaseUrl: "wss://127.0.0.1:14036",
      },
    ]) {
      it.effect(`does not share cookies with a primary on another ${boundary}`, () => {
        vi.stubEnv("VITE_HTTP_URL", httpBaseUrl);
        vi.stubEnv("VITE_WS_URL", wsBaseUrl);
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        return Effect.gen(function* () {
          yield* HttpClient.get(`${httpBaseUrl}/api/connect/link-state`);

          const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
          expect(request.url).toBe(`${httpBaseUrl}/api/connect/link-state`);
          expect(request.credentials).not.toBe("include");
          expect(request.headers.get("authorization")).toBeNull();
        }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
      });
    }
  });

  it.effect("uses bearer auth without cookies for desktop-managed primaries", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "t3code://app" },
        dispatchEvent: vi.fn(),
        desktopBridge: {
          getLocalEnvironmentBootstrap: () => ({
            label: "Local environment",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: "desktop-bootstrap-token",
          }),
          getLocalEnvironmentSession: vi.fn().mockResolvedValue({
            token: "desktop-bearer-token",
            user: null,
            accountId: null,
            generation: 0,
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          }),
          setLocalEnvironmentAccount: vi.fn().mockResolvedValue(undefined),
          getLocalEnvironmentBootstraps: () => [],
        } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/connect/link-state");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });
});
