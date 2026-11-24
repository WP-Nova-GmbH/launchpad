import * as Context from "effect/Context";

export class WebCrypto extends Context.Service<
  WebCrypto,
  { readonly subtle: typeof globalThis.crypto.subtle }
>()("launchpad-relay/WebCrypto") {}
