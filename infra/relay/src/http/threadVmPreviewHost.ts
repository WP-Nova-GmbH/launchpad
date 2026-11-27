import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

export function threadVmPreviewRequestUrl(request: HttpServerRequest.HttpServerRequest) {
  // Workers retain the absolute URL; Node receives the authority in Host.
  try {
    return Option.some(new URL(request.originalUrl));
  } catch {
    return HttpServerRequest.toURL(request);
  }
}

/** Reserve the entire preview namespace, including malformed or unknown grant hosts. */
export function isThreadVmPreviewHost(
  request: HttpServerRequest.HttpServerRequest,
  baseUrl?: string,
) {
  if (!baseUrl) return false;
  const parsed = threadVmPreviewRequestUrl(request);
  if (Option.isNone(parsed)) return false;
  const hostname = new URL(baseUrl).hostname;
  return parsed.value.hostname === hostname || parsed.value.hostname.endsWith(`.${hostname}`);
}
