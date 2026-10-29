import { describe, expect, it } from "vite-plus/test";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as Schema from "effect/Schema";

import {
  RelayApi,
  RelayDeviceRegistrationRequest,
  RelayHealthResponse,
  RelayPortableThreadPlacement,
  RelayThreadMove,
  RelayThreadVmRepositoryBinding,
} from "./relay.ts";

const decodeDevice = Schema.decodeUnknownExit(RelayDeviceRegistrationRequest);
const decodeMove = Schema.decodeUnknownSync(RelayThreadMove);

describe("VM Git metadata compatibility", () => {
  const decode = Schema.decodeUnknownSync(RelayThreadVmRepositoryBinding);
  const binding = {
    environmentId: "environment",
    threadId: "thread",
    generation: 2,
    repositoryId: "repository",
    canonicalKey: "github.com/team/repo",
    operationId: "00000000-0000-4000-8000-000000000001",
  };
  it("accepts old relay replies and distinguishes unavailable from confirmed missing App", () => {
    expect(decode(binding)).toEqual(binding);
    for (const git of [
      { status: "unknown" },
      { status: "unconfigured" },
      { status: "pending", appId: "123" },
      { status: "pending", appId: "123", appSlug: "launchpad" },
      {
        status: "ready",
        appId: "123",
        appSlug: "launchpad",
        botUserId: 456,
        name: "launchpad[bot]",
        email: "456+launchpad[bot]@users.noreply.github.com",
      },
    ])
      expect(decode({ ...binding, git }).git).toEqual(git);
  });
  it("rejects incomplete bot identities", () => {
    expect(() =>
      decode({ ...binding, git: { status: "ready", appId: "123", name: "bot" } }),
    ).toThrow();
  });
});
const device = {
  deviceId: "device",
  label: "Phone",
  pushToken: "token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("portable thread return metadata", () => {
  const placement = {
    threadId: "thread",
    organizationId: "organization",
    repositoryId: "repository",
    ownerUserId: "owner",
    environmentId: "vm",
    projectId: "vm:thread",
    generation: 2,
    operationId: null,
  };
  const decodePlacement = Schema.decodeUnknownSync(RelayPortableThreadPlacement);

  it("retains the original project independently of the current placement", () => {
    const originalLocation = { environmentId: "mac", projectId: "original-project" };
    expect(decodePlacement({ ...placement, originalLocation }).originalLocation).toEqual(
      originalLocation,
    );
    expect(decodePlacement({ ...placement, originalLocation: null }).originalLocation).toBeNull();
  });

  it("rejects an incomplete original location instead of accepting a machine without a project", () => {
    expect(() =>
      decodePlacement({ ...placement, originalLocation: { environmentId: "mac" } }),
    ).toThrow();
  });

  it("preserves repository aliases needed to check a move destination", () => {
    const move = decodeMove({
      manifestArtifactId: null,
      threadId: "thread",
      operationId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "owner",
      sourceEnvironmentId: "vm",
      expectedGeneration: 2,
      destinationEnvironmentId: "mac",
      destinationProjectId: "original-project",
      repositoryCanonicalKeys: ["github.com/team/repo", "git.example.com/team/repo"],
      phase: "preparing",
      sourceCursor: null,
      manifestSha256: null,
    });
    expect(move.repositoryCanonicalKeys).toEqual([
      "github.com/team/repo",
      "git.example.com/team/repo",
    ]);
  });
});

describe("relay health compatibility", () => {
  const decodeHealth = Schema.decodeUnknownSync(RelayHealthResponse);

  it("accepts older relays without VM capability metadata", () => {
    expect(decodeHealth({ ok: true, service: "relay" })).toEqual({
      ok: true,
      service: "relay",
    });
  });

  it.each([true, false])("preserves explicit VM host configuration (%s)", (configured) => {
    expect(decodeHealth({ ok: true, service: "relay", threadVmConfigured: configured })).toEqual({
      ok: true,
      service: "relay",
      threadVmConfigured: configured,
    });
  });

  it("rejects malformed VM capability metadata", () => {
    expect(() =>
      decodeHealth({ ok: true, service: "relay", threadVmConfigured: "true" }),
    ).toThrow();
  });
});

describe("mobile device platforms", () => {
  it.each([
    [23, "Failure"],
    [24, "Success"],
    [37, "Success"],
  ])("enforces the Android minimum without an upper bound (API %i)", (androidApiLevel, result) => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel })._tag).toBe(result);
  });

  it("accepts Android tokens without Apple routing and preserves older iOS registrations", () => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel: 36 })._tag).toBe(
      "Success",
    );
    expect(decodeDevice({ ...device, platform: "ios", iosMajorVersion: 18 })._tag).toBe("Success");
  });
  it("rejects missing platform versions and Apple activity tokens on Android", () => {
    expect(decodeDevice({ ...device, platform: "ios" })._tag).toBe("Failure");
    expect(decodeDevice({ ...device, platform: "android" })._tag).toBe("Failure");
    expect(
      decodeDevice({
        ...device,
        platform: "android",
        androidApiLevel: 36,
        pushToStartToken: "apple-token",
      })._tag,
    ).toBe("Failure");
  });
});

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});
