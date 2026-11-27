import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { ThreadVmPreviewDenied } from "../threads/ThreadVmPreviewStore.ts";

export class ThreadVmPreviewWebSocket extends Context.Service<
  ThreadVmPreviewWebSocket,
  {
    readonly open: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly guard: Effect.Effect<void, ThreadVmPreviewDenied>;
    }) => Effect.Effect<HttpServerResponse.HttpServerResponse, ThreadVmPreviewDenied>;
  }
>()("launchpad-relay/http/ThreadVmPreviewWebSocket") {}
