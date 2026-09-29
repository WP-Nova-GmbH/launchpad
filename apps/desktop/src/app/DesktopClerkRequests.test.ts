import type * as Electron from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

import { installDesktopClerkRequestHeaders } from "./DesktopClerkRequests.ts";

const hostname = "example.clerk.accounts.dev";

function setup(scheme = "t3code-dev") {
  type Listener = Parameters<Electron.WebRequest["onBeforeSendHeaders"]>[0];
  let listener: Listener;
  const onBeforeSendHeaders = vi.fn(
    (_filter: Electron.WebRequestFilter | Listener, nextListener?: Listener) => {
      listener = nextListener ?? null;
    },
  );
  type ResponseListener = Parameters<Electron.WebRequest["onHeadersReceived"]>[0];
  let responseListener: ResponseListener;
  const onHeadersReceived = vi.fn(
    (_filter: Electron.WebRequestFilter | ResponseListener, nextListener?: ResponseListener) => {
      responseListener = nextListener ?? null;
    },
  );
  let mainContents = {
    id: 1,
    isDestroyed: () => false,
    mainFrame: { url: `${scheme}://app/settings` },
  } as Electron.WebContents;
  const cleanup = installDesktopClerkRequestHeaders(
    { onBeforeSendHeaders, onHeadersReceived },
    { hostname, rendererOrigin: `${scheme}://app`, getMainWebContents: () => mainContents },
  );
  const request = (overrides: Partial<Electron.OnBeforeSendHeadersListenerDetails> = {}) => {
    const details = {
      url: `https://${hostname}/v1/client/sign_ins?_is_native=1&_electron_sdk_version=0.0.44`,
      method: "POST",
      webContentsId: mainContents.id,
      frame: mainContents.mainFrame,
      initiatorOrigin: `${scheme}://app`,
      requestHeaders: {
        origin: `${scheme}://app`,
        authorization: "Bearer fake-client-token",
        "content-type": "application/x-www-form-urlencoded",
      },
      ...overrides,
    } as Electron.OnBeforeSendHeadersListenerDetails;
    const callback = vi.fn<(response: Electron.BeforeSendResponse) => void>();
    listener!(details, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    return { original: details.requestHeaders, sent: callback.mock.calls[0]![0].requestHeaders };
  };
  const response = (
    overrides: Partial<Omit<Electron.OnHeadersReceivedListenerDetails, "initiatorOrigin">> & {
      initiatorOrigin?: string | undefined;
    } = {},
  ) => {
    const details = {
      url: `https://${hostname}/v1/environment?_is_native=1`,
      method: "GET",
      webContentsId: mainContents.id,
      frame: mainContents.mainFrame,
      initiatorOrigin: `${scheme}://app`,
      statusCode: 200,
      responseHeaders: {
        "Content-Type": ["application/json"],
        Authorization: ["Bearer fake-token"],
      },
      ...overrides,
    } as Electron.OnHeadersReceivedListenerDetails;
    const callback = vi.fn<(response: Electron.HeadersReceivedResponse) => void>();
    responseListener!(details, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    return {
      original: details.responseHeaders,
      received: callback.mock.calls[0]![0].responseHeaders ?? details.responseHeaders,
    };
  };
  return {
    request,
    response,
    cleanup,
    onBeforeSendHeaders,
    onHeadersReceived,
    replaceWindow: () => {
      mainContents = {
        ...mainContents,
        id: 2,
        mainFrame: { url: `${scheme}://app/` },
      } as Electron.WebContents;
    },
  };
}

describe("desktop Clerk request headers", () => {
  it.each(["t3code-dev", "t3code"])("uses native authentication from %s", (scheme) => {
    const { request } = setup(scheme);
    const { sent, original } = request();
    expect(sent).toEqual({
      authorization: "Bearer fake-client-token",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(original.origin).toBe(`${scheme}://app`);
  });

  it.each(["t3code-dev", "t3code"])("makes native Clerk responses readable from %s", (scheme) => {
    const { received, original } = setup(scheme).response();
    expect(received).toEqual({
      "Content-Type": ["application/json"],
      Authorization: ["Bearer fake-token"],
      "Access-Control-Allow-Origin": [`${scheme}://app`],
      "Access-Control-Expose-Headers": ["Authorization"],
    });
    expect(original).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it("preserves exposed headers and replaces differently cased CORS headers without duplicates", () => {
    const { received } = setup().response({
      responseHeaders: {
        "access-control-allow-origin": ["*"],
        "access-control-expose-headers": ["X-Clerk-Trace-Id, authorization"],
        "Cache-Control": ["no-store"],
      },
    });
    expect(received).toEqual({
      "Access-Control-Allow-Origin": ["t3code-dev://app"],
      "Access-Control-Expose-Headers": ["X-Clerk-Trace-Id, authorization"],
      "Cache-Control": ["no-store"],
    });
  });

  it.each([
    { url: "https://relay.example.com/v1/client?_is_native=1" },
    { url: `https://${hostname}/v1/client` },
    { url: `https://${hostname}/other?_is_native=1` },
    { method: "OPTIONS" },
    { initiatorOrigin: "https://example.com" },
    { initiatorOrigin: undefined },
    { webContentsId: 9 },
    { frame: null },
    { frame: { url: "t3code-dev://app/" } as Electron.WebFrameMain },
  ])("does not grant CORS access to unrelated responses: %j", (overrides) => {
    const { received, original } = setup().response(overrides);
    expect(received).toEqual(original);
  });

  it("handles initial requests without a token and mixed header casing", () => {
    const { sent } = setup().request({
      requestHeaders: { Origin: "t3code-dev://app", Accept: "*/*" },
    });
    expect(sent).toEqual({ Accept: "*/*" });
  });

  it.each([
    { url: "https://relay.example.com/v1/client/sign_ins?_is_native=1" },
    { url: `https://${hostname}.example.com/v1/client/sign_ins?_is_native=1` },
    { url: `http://${hostname}/v1/client/sign_ins?_is_native=1` },
    { url: `https://${hostname}:444/v1/client/sign_ins?_is_native=1` },
    { url: `https://${hostname}/other?_is_native=1` },
    { url: `https://${hostname}/v1/client/sign_ins` },
    { url: `https://${hostname}/v1/client/sign_ins?_is_native=0` },
    { method: "OPTIONS" },
    { webContentsId: 9 },
    { frame: null },
    { frame: { url: "t3code-dev://app/" } as Electron.WebFrameMain },
    { requestHeaders: { origin: "https://example.com", authorization: "Bearer fake" } },
  ])("preserves unrelated requests: %j", (overrides) => {
    const { sent, original } = setup().request(overrides);
    expect(sent).toEqual(original);
  });

  it("uses the replacement main window without registering another session listener", () => {
    const harness = setup();
    harness.replaceWindow();
    expect(harness.request().sent).not.toHaveProperty("origin");
    expect(harness.request({ webContentsId: 1 }).sent).toHaveProperty("origin");
    expect(harness.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
    harness.cleanup();
    expect(harness.onBeforeSendHeaders).toHaveBeenLastCalledWith(null);
    expect(harness.onHeadersReceived).toHaveBeenLastCalledWith(null);
  });
});
