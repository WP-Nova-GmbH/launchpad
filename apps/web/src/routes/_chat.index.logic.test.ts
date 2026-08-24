import { describe, expect, it } from "vite-plus/test";

import { resolveStartRouteMode } from "./_chat.index.logic";

const emptyHostedStart = {
  isHostedStatic: true,
  environmentCount: 0,
  organizationRepositoryCount: 0,
  organizationProjectCount: 0,
  organizationCatalogPending: false,
  organizationCatalogError: null,
} as const;

describe("resolveStartRouteMode", () => {
  it("shows organization repositories without a connected environment", () => {
    expect(
      resolveStartRouteMode({
        ...emptyHostedStart,
        organizationRepositoryCount: 2,
      }),
    ).toBe("workspace");
  });

  it("shows cataloged organization projects while their environment is offline", () => {
    expect(
      resolveStartRouteMode({
        ...emptyHostedStart,
        organizationProjectCount: 3,
      }),
    ).toBe("workspace");
  });

  it("waits for the catalog before deciding that a new user needs onboarding", () => {
    expect(
      resolveStartRouteMode({
        ...emptyHostedStart,
        organizationCatalogPending: true,
      }),
    ).toBe("pending");
    expect(resolveStartRouteMode(emptyHostedStart)).toBe("onboarding");
  });

  it("keeps catalog failures visible so the user can retry", () => {
    expect(
      resolveStartRouteMode({
        ...emptyHostedStart,
        organizationCatalogError: "Could not read organization",
      }),
    ).toBe("workspace");
  });
});
