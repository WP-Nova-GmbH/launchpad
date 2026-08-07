import { describe, expect, it, vi } from "vite-plus/test";

// `main.tsx` mounts `ClerkProvider` only when T3 Connect is configured, and
// this is what Clerk really does outside one.
vi.mock("@clerk/react", () => ({
  useAuth: () => {
    throw new Error(
      "@clerk/react: useAuth can only be used within the <ClerkProvider /> component",
    );
  },
}));

vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => false,
}));

import { OrganizationSettings } from "./OrganizationSettings";

describe("OrganizationSettings without T3 Connect configured", () => {
  it("renders the notice instead of reading Clerk", () => {
    expect(() => OrganizationSettings()).not.toThrow();
  });
});
