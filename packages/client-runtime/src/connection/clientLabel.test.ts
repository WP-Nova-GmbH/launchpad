import { describe, expect, it } from "vite-plus/test";
import { suggestClientLabel } from "./clientLabel.ts";
describe("suggestClientLabel", () => {
  it("prefers a remembered choice, then account/device and descriptive details", () => {
    expect(
      suggestClientLabel({ remembered: " My phone ", displayName: "Stefan", deviceType: "mobile" }),
    ).toBe("My phone");
    expect(suggestClientLabel({ displayName: "Stefan", deviceType: "mobile" })).toBe(
      "Stefan's Phone",
    );
    expect(suggestClientLabel({ os: "iOS", browser: "Safari" })).toBe("iOS · Safari");
    expect(suggestClientLabel({ deviceType: "unknown" })).toBe("");
    expect(
      suggestClientLabel({ displayName: "x".repeat(90), deviceType: "tablet" }).length,
    ).toBeLessThanOrEqual(80);
  });
});
