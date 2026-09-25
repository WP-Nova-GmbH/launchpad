import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { RUNNER_CREDENTIAL_ENV_PREFIX } from "@t3tools/shared/runnerCredentials";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("leaves inherited provider homes unchanged", () => {
    const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
        baseEnv,
      ),
    ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("withholds runner-held credentials from the agent's process environment", () => {
    // ADR-0009: an agent must not be able to read the credential the runner
    // pushes with, including out of /proc/<pid>/environ.
    const merged = mergeProviderInstanceEnvironment(
      [{ name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true }],
      { PATH: "/bin", [`${RUNNER_CREDENTIAL_ENV_PREFIX}GH_TOKEN`]: "ghp_runner" },
    );

    expect(merged[`${RUNNER_CREDENTIAL_ENV_PREFIX}GH_TOKEN`]).toBeUndefined();
    expect(merged).toMatchObject({ OPENROUTER_API_KEY: "sk-or-test", PATH: "/bin" });
  });

  it("withholds them even when the instance declares no environment of its own", () => {
    // The early return for "no instance environment" used to hand back the
    // base environment untouched, which would have leaked the credential.
    expect(
      mergeProviderInstanceEnvironment(undefined, {
        PATH: "/bin",
        [`${RUNNER_CREDENTIAL_ENV_PREFIX}GH_TOKEN`]: "ghp_runner",
      }),
    ).toEqual({ PATH: "/bin" });
  });
});
