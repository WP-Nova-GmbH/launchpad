import { describe, expect, it } from "vite-plus/test";
import { RUNNER_CREDENTIAL_ENV_PREFIX } from "@t3tools/shared/runnerCredentials";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
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
