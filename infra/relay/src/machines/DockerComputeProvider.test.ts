import { describe, expect, it } from "@effect/vitest";

import { containerRelayUrl } from "./DockerComputeProvider.ts";

describe("containerRelayUrl", () => {
  it("rewrites loopback relay origins to the Docker host gateway", () => {
    expect(containerRelayUrl("http://127.0.0.1:8610")).toBe("http://host.docker.internal:8610");
    expect(containerRelayUrl("http://localhost:8610")).toBe("http://host.docker.internal:8610");
  });

  it("leaves reachable origins alone", () => {
    expect(containerRelayUrl("https://relay.example.test")).toBe("https://relay.example.test");
  });
});
