import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedChannelSelectionUrl,
  buildHostedPairingUrl,
  isHostedStaticApp,
  readHostedPairingRequest,
  resolveHostedPairingRequest,
} from "./hostedPairing";
import { stripPairingTokenFromUrl } from "./pairingUrl";

describe("hostedPairing", () => {
  afterEach(() => {
    resolveHostedPairingRequest(new URL("https://preview.t3.codes/"));
    vi.unstubAllEnvs();
  });

  it("keeps a pending pairing after removing its token from the address bar", () => {
    const url = new URL(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fbackend.example.com#token=pairing-token",
    );
    const request = resolveHostedPairingRequest(url);
    const cleaned = stripPairingTokenFromUrl(url);
    expect(cleaned.hash).toBe("");
    expect(readHostedPairingRequest(cleaned)).toBeNull();
    expect(resolveHostedPairingRequest(cleaned)).toEqual(request);
    expect(request?.token).toBe("pairing-token");
  });

  it("discards a pending pairing when leaving its page", () => {
    const url = new URL("https://preview.t3.codes/pair?host=backend.example.com#token=old-token");
    resolveHostedPairingRequest(url);
    expect(resolveHostedPairingRequest(new URL("https://preview.t3.codes/"))).toBeNull();
    expect(resolveHostedPairingRequest(stripPairingTokenFromUrl(url))).toBeNull();
  });

  it.each([
    "https://preview.t3.codes/pair?host=other.example.com",
    "https://other.t3.codes/pair?host=backend.example.com",
  ])("does not reuse pending credentials on a different destination: %s", (destination) => {
    const url = new URL("https://preview.t3.codes/pair?host=backend.example.com#token=old-token");
    resolveHostedPairingRequest(url);
    expect(resolveHostedPairingRequest(new URL(destination))).toBeNull();
    expect(resolveHostedPairingRequest(stripPairingTokenFromUrl(url))).toBeNull();
  });

  it("replaces a pending pairing when a fresh link is opened", () => {
    const url = new URL("https://preview.t3.codes/pair?host=backend.example.com#token=old-token");
    resolveHostedPairingRequest(url);
    const fresh = new URL(url);
    fresh.hash = "token=new-token";
    expect(resolveHostedPairingRequest(fresh)?.token).toBe("new-token");
    expect(resolveHostedPairingRequest(stripPairingTokenFromUrl(fresh))?.token).toBe("new-token");
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.t3.codes/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      }),
    );

    expect(url.origin).toBe("https://preview.t3.codes");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("builds hosted channel selection URLs through the configured router origin", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    const url = new URL(
      buildHostedChannelSelectionUrl({
        channel: "nightly",
      }),
    );

    expect(url.origin).toBe("https://app.t3.codes");
    expect(url.pathname).toBe("/__t3code/channel");
    expect(url.searchParams.get("channel")).toBe("nightly");
    expect(url.searchParams.has("next")).toBe(false);
  });

  it("ignores incomplete hosted pairing requests", () => {
    expect(
      readHostedPairingRequest(new URL("https://app.t3.codes/pair?host=backend.example.com")),
    ).toBeNull();
    expect(
      readHostedPairingRequest(new URL("https://app.t3.codes/pair?token=ABCD1234")),
    ).toBeNull();
  });

  it("detects the hosted static app only when no backend URL is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://preview.t3.codes/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://preview.t3.codes/pair"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://backend.example.com/"))).toBe(false);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://preview.t3.codes/"))).toBe(false);
  });

  it("detects hosted channel aliases as static apps", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://nightly.app.t3.codes/"))).toBe(true);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://nightly.app.t3.codes/"))).toBe(false);
  });
});
