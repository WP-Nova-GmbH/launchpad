import { describe, expect, it } from "vite-plus/test";

import { isSecureRelayUrl, normalizeSecureRelayUrl } from "./relayUrl.ts";

describe("normalizeSecureRelayUrl", () => {
  it("normalizes secure relay origins", () => {
    expect(normalizeSecureRelayUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeSecureRelayUrl("https://relay.example.test:8443/")).toBe(
      "https://relay.example.test:8443",
    );
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "accepts the local development relay on %s",
    (host) => {
      const origin = `http://${host}:8610`;
      expect(normalizeSecureRelayUrl(` ${origin}/// `)).toBe(origin);
      expect(isSecureRelayUrl(origin)).toBe(true);
    },
  );

  it.each([
    "http://relay.example.test",
    "http://192.168.1.10:8610",
    "http://0.0.0.0:8610",
    "http://localhost.example.test:8610",
    "http://127.0.0.1.example.test:8610",
    "http://localhost@relay.example.test:8610",
    "http://user:password@localhost:8610",
    "http://localhost:8610/path",
    "http://localhost:8610?query=value",
    "http://localhost:8610#fragment",
    "ftp://localhost:8610",
    "https://user:password@relay.example.test",
    "https://relay.example.test/path",
    "https://relay.example.test?query=value",
    "https://relay.example.test#fragment",
    "not a url",
  ])("rejects unsafe relay URL %s", (value) => {
    expect(normalizeSecureRelayUrl(value)).toBeNull();
    expect(isSecureRelayUrl(value)).toBe(false);
  });
});
