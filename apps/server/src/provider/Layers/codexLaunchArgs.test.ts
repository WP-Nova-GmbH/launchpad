import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexSessionAppServerArgs,
  managedCodexEnvironment,
  managedCodexModelIssue,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("organization-managed Codex launch", () => {
  it("pins every launch route after conflicting user, environment and session arguments", () => {
    const overridden =
      '-c model_provider="other" -c model_providers.launchpad_vm.env_key="OPENAI_API_KEY"';
    for (const args of [
      codexAppServerArgs(overridden, "selected-connection"),
      codexExecLaunchArgs(overridden, "selected-connection"),
      codexSessionAppServerArgs(
        ["-c", 'model_provider="from-session"'],
        overridden,
        "selected-connection",
      ),
    ]) {
      const configs = args.flatMap((arg, index) => (arg === "-c" ? [args[index + 1]!] : []));
      NodeAssert.equal(
        configs.findLast((value) => value.startsWith("model_provider=")),
        'model_provider="launchpad_vm"',
      );
      const provider = configs.at(-1)!;
      NodeAssert.ok(provider.startsWith("model_providers.launchpad_vm={"));
      NodeAssert.ok(provider.includes('base_url="https://api.openai.com/v1"'));
      NodeAssert.ok(provider.includes("requires_openai_auth=false"));
      NodeAssert.ok(provider.includes('command="/opt/launchpad/server/t3"'));
      NodeAssert.ok(
        provider.includes('"__thread-vm-codex-token","--connection-id","selected-connection"'),
      );
      NodeAssert.ok(!provider.includes("env_key"));
      NodeAssert.ok(!provider.includes("experimental_bearer_token"));
    }
  });

  it("does not inherit personal credentials or an overriding Launchpad argument variable", () => {
    NodeAssert.deepEqual(
      managedCodexEnvironment({
        PATH: "/usr/bin",
        T3CODE_CODEX_LAUNCH_ARGS: "--bad",
        OPENAI_API_KEY: "personal",
        CODEX_API_KEY: "other",
        OPENAI_BASE_URL: "https://other",
      }),
      { PATH: "/usr/bin" },
    );
    NodeAssert.equal(managedCodexModelIssue("gpt-6-astra"), undefined);
    NodeAssert.match(managedCodexModelIssue("gpt-5.5")!, /Select a supported model/);
  });
});
