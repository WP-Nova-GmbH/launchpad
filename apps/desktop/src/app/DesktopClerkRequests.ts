import type * as Electron from "electron";

export function installDesktopClerkRequestHeaders(
  webRequest: Pick<Electron.WebRequest, "onBeforeSendHeaders" | "onHeadersReceived">,
  input: {
    hostname: string;
    rendererOrigin: string;
    getMainWebContents: () => Electron.WebContents | undefined;
  },
) {
  const clerkOrigin = `https://${input.hostname}`;
  const filter = { urls: [`${clerkOrigin}/v1/*`] };
  const isNativeClerkRequest = (
    details:
      | Electron.OnBeforeSendHeadersListenerDetails
      | Electron.OnHeadersReceivedListenerDetails,
  ) => {
    const url = new URL(details.url);
    const contents = input.getMainWebContents();
    return (
      details.method !== "OPTIONS" &&
      url.origin === clerkOrigin &&
      url.pathname.startsWith("/v1/") &&
      url.searchParams.get("_is_native") === "1" &&
      details.initiatorOrigin === input.rendererOrigin &&
      contents !== undefined &&
      !contents.isDestroyed() &&
      details.webContentsId === contents.id &&
      details.frame === contents.mainFrame
    );
  };
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (!isNativeClerkRequest(details)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    // Clerk's Electron SDK uses native token authentication, but Chromium
    // still adds Origin. Clerk rejects the combination. Strip it here, after
    // Chromium adds it, including requests before a client token is cached.
    const requestHeaders = { ...details.requestHeaders };
    for (const name of Object.keys(requestHeaders)) {
      if (name.toLowerCase() === "origin" && requestHeaders[name] === input.rendererOrigin) {
        delete requestHeaders[name];
      }
    }
    callback({ requestHeaders });
  });
  webRequest.onHeadersReceived(filter, (details, callback) => {
    if (!isNativeClerkRequest(details)) {
      callback({});
      return;
    }

    // Native responses omit CORS headers, but the renderer still enforces CORS.
    // Allow only our renderer to read them, including the client token the SDK
    // saves from Authorization for subsequent requests.
    const responseHeaders = { ...details.responseHeaders };
    const exposedHeaders: string[] = [];
    for (const [name, values] of Object.entries(responseHeaders)) {
      if (name.toLowerCase() === "access-control-allow-origin") {
        delete responseHeaders[name];
      } else if (name.toLowerCase() === "access-control-expose-headers") {
        exposedHeaders.push(
          ...values.flatMap((value) => value.split(",").map((part) => part.trim())).filter(Boolean),
        );
        delete responseHeaders[name];
      }
    }
    if (!exposedHeaders.some((name) => name.toLowerCase() === "authorization")) {
      exposedHeaders.push("Authorization");
    }
    responseHeaders["Access-Control-Allow-Origin"] = [input.rendererOrigin];
    responseHeaders["Access-Control-Expose-Headers"] = [exposedHeaders.join(", ")];
    callback({ responseHeaders });
  });
  // These hooks own the session's sole listener for each event.
  return () => {
    webRequest.onBeforeSendHeaders(null);
    webRequest.onHeadersReceived(null);
  };
}
