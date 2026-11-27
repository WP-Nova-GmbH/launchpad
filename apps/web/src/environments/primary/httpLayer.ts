import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readDesktopPrimaryBearerToken } from "./desktopAuth";
import {
  isLoopbackHostname,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "./target";

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

function withPrimaryBearerToken(client: HttpClient.HttpClient): HttpClient.HttpClient {
  return client.pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.promise(readDesktopPrimaryBearerToken).pipe(
        Effect.map((bearerToken) =>
          bearerToken ? HttpClientRequest.bearerToken(request, bearerToken) : request,
        ),
      ),
    ),
  );
}

function withPrimaryBrowserCookies(client: HttpClient.HttpClient): HttpClient.HttpClient {
  const primary = readPrimaryEnvironmentTarget();
  if (!primary) return client;
  const backend = new URL(primary.target.httpBaseUrl);
  const page = new URL(window.location.origin);
  if (
    backend.origin === page.origin ||
    backend.hostname !== page.hostname ||
    backend.protocol !== page.protocol ||
    !isLoopbackHostname(backend.hostname)
  ) {
    return client;
  }

  // Dev control requests can use the backend port directly; only this same-host
  // backend may receive the browser's host-scoped cookie across origins.
  return client.pipe(
    HttpClient.transform((response, request) =>
      new URL(request.url).origin === backend.origin
        ? response.pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
          )
        : response,
    ),
  );
}

export function makePrimaryEnvironmentHttpLayer() {
  return Layer.unwrap(
    Effect.sync(() => {
      const baseLayer = remoteHttpClientLayer(globalThis.fetch);
      if (isSameOriginBrowserPrimary()) {
        return Layer.merge(
          Layer.effect(
            HttpClient.HttpClient,
            Effect.map(HttpClient.HttpClient, withPrimaryBrowserCookies),
          ).pipe(Layer.provide(baseLayer)),
          Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
        );
      }

      const bearerClientLayer = Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, withPrimaryBearerToken),
      ).pipe(Layer.provide(baseLayer));

      return Layer.merge(
        bearerClientLayer,
        Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" }),
      );
    }),
  );
}

export const primaryEnvironmentHttpLayer = makePrimaryEnvironmentHttpLayer();
