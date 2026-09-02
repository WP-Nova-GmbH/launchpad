import * as NodePath from "node:path";

import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { missingInstallableProviders, withBinDirectories } from "./executorProviderToolchain.ts";

function provider(driver: string, installed: boolean, instanceId = driver): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    installed,
  } as unknown as ServerProvider;
}

describe("missingInstallableProviders", () => {
  it("names the installable providers whose CLI is absent, once each", () => {
    expect(
      [
        ...missingInstallableProviders([
          provider("codex", false),
          provider("codex", false, "codex-work"),
          provider("claudeAgent", true),
          provider("cursor", false),
          provider("grok", false),
          provider("opencode", false),
        ]),
      ].sort(),
    ).toEqual(["codex", "cursor", "opencode"]);
  });

  it("is empty when everything installable is present", () => {
    expect(missingInstallableProviders([provider("codex", true), provider("grok", false)])).toEqual(
      [],
    );
  });
});

describe("withBinDirectories", () => {
  it("prepends each missing directory once, in order", () => {
    const d = NodePath.delimiter;
    const once = withBinDirectories({ PATH: "/usr/bin" }, ["/home/x/.local/bin", "/opt/node/bin"]);
    expect(once).toBe(`/home/x/.local/bin${d}/opt/node/bin${d}/usr/bin`);
    expect(withBinDirectories({ PATH: once }, ["/opt/node/bin", "/home/x/.local/bin"])).toBe(once);
  });

  it("copes with an empty PATH", () => {
    expect(withBinDirectories({}, ["/opt/node/bin"])).toBe("/opt/node/bin");
  });
});
