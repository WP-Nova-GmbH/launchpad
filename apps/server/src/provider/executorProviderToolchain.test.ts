import * as NodePath from "node:path";

import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { missingInstallableProviders, withUserLocalBin } from "./executorProviderToolchain.ts";

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

describe("withUserLocalBin", () => {
  it("prepends ~/.local/bin once", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const once = withUserLocalBin(path, { PATH: "/usr/bin" });
      expect(once.endsWith(`${NodePath.delimiter}/usr/bin`)).toBe(true);
      expect(once).toMatch(/\.local[\\/]bin/);
      expect(withUserLocalBin(path, { PATH: once })).toBe(once);
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));
});
