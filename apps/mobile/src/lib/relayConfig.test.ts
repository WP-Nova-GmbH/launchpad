import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveConfiguredRelayUrl } from "./relayConfig";

const { expoConfig } = vi.hoisted(() => ({
  expoConfig: { extra: { relay: { url: " https://relay.example.test/// " } } },
}));

vi.mock("expo-constants", () => ({ default: { expoConfig } }));

beforeEach(() => {
  expoConfig.extra.relay.url = " https://relay.example.test/// ";
});

describe("resolveConfiguredRelayUrl", () => {
  it("reads and normalizes the current Expo configuration on each call", () => {
    expect(resolveConfiguredRelayUrl()).toBe("https://relay.example.test");
    expoConfig.extra.relay.url = "http://127.0.0.1:8610/";
    expect(resolveConfiguredRelayUrl()).toBe("http://127.0.0.1:8610");
  });

  it("honors explicit configuration without falling back to the build configuration", () => {
    expect(resolveConfiguredRelayUrl({ relay: { url: "https://override.example.test/" } })).toBe(
      "https://override.example.test",
    );
    expect(resolveConfiguredRelayUrl({})).toBeNull();
  });

  it("returns null for missing, non-string, or insecure relay URLs", () => {
    expect(resolveConfiguredRelayUrl({ relay: {} })).toBeNull();
    expect(resolveConfiguredRelayUrl({ relay: { url: null } })).toBeNull();
    expect(resolveConfiguredRelayUrl({ relay: { url: 42 } })).toBeNull();
    expect(resolveConfiguredRelayUrl({ relay: { url: "http://relay.example.test" } })).toBeNull();
  });
});
