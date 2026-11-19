import { EnvironmentId } from "@t3tools/contracts";
import {
  PrimaryConnectionTarget,
  SshConnectionTarget,
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../lib/runtime", () => ({ runtime: {} }));
vi.mock("../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironment: vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../environments/primary/target", () => ({ readPrimaryEnvironmentTarget: vi.fn() }));
vi.mock("../localApi", () => ({ ensureLocalApi: vi.fn() }));

import { canUseLocalCodexVmSignIn } from "./codexVmConnection";

const primary = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("local"),
  label: "Local",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const local = {
  target: primary,
  source: "window-origin",
  windowOrigin: "http://localhost:3773",
  desktop: false,
  primaryRunningDistro: null,
};

describe("Codex VM sign-in loopback topology", () => {
  it("allows locally served web and the native desktop primary", () => {
    expect(canUseLocalCodexVmSignIn(local)).toBe(true);
    expect(
      canUseLocalCodexVmSignIn({
        ...local,
        desktop: true,
        source: "desktop-managed",
        windowOrigin: "t3code://desktop",
      }),
    ).toBe(true);
  });
  it("rejects a selected SSH, relay or secondary local backend even when its connection uses loopback", () => {
    const base = { environmentId: EnvironmentId.make("remote"), label: "Remote" };
    for (const target of [
      new SshConnectionTarget({ ...base, connectionId: "ssh:remote" }),
      new RelayConnectionTarget(base),
      new BearerConnectionTarget({ ...base, connectionId: "local:wsl:Ubuntu" }),
    ])
      expect(canUseLocalCodexVmSignIn({ ...local, target })).toBe(false);
  });
  it("rejects remote web, configured desktop remotes and WSL primary without forwarding support", () => {
    expect(canUseLocalCodexVmSignIn({ ...local, windowOrigin: "https://app.launchpad.test" })).toBe(
      false,
    );
    expect(
      canUseLocalCodexVmSignIn({
        ...local,
        target: new PrimaryConnectionTarget({
          ...primary,
          httpBaseUrl: "https://remote.test",
          wsBaseUrl: "wss://remote.test",
        }),
      }),
    ).toBe(false);
    expect(canUseLocalCodexVmSignIn({ ...local, desktop: true, source: "configured" })).toBe(false);
    expect(
      canUseLocalCodexVmSignIn({
        ...local,
        desktop: true,
        source: "desktop-managed",
        primaryRunningDistro: "Ubuntu",
      }),
    ).toBe(false);
  });
});
