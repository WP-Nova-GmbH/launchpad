export function normalizeSecureRelayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    // The local development relay runs without TLS; remote relays require HTTPS.
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !/^\/+$/u.test(url.pathname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isSecureRelayUrl(value: string): boolean {
  return normalizeSecureRelayUrl(value) !== null;
}
