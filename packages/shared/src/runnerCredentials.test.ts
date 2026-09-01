import { describe, expect, it } from "@effect/vitest";

import {
  captureRunnerCredentials,
  RUNNER_CREDENTIAL_ENV_PREFIX,
  withOrganizationGithubToken,
  withoutRunnerCredentials,
  withRunnerSourceControlCredentials,
} from "./runnerCredentials.ts";

const RUNNER_GH_TOKEN = `${RUNNER_CREDENTIAL_ENV_PREFIX}GH_TOKEN`;

describe("withoutRunnerCredentials", () => {
  it("removes every runner-prefixed variable", () => {
    expect(
      withoutRunnerCredentials({
        PATH: "/usr/bin",
        [RUNNER_GH_TOKEN]: "ghp_runner",
        [`${RUNNER_CREDENTIAL_ENV_PREFIX}FUTURE_SECRET`]: "whatever",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("leaves a credential the machine's owner set for themselves alone", () => {
    // Scrubbing an ambient GH_TOKEN would break agents that legitimately use
    // the developer's own credential. Only runner-held values are taken away.
    const env = { PATH: "/usr/bin", GH_TOKEN: "ghp_developer" };
    expect(withoutRunnerCredentials(env)).toEqual(env);
  });

  it("returns the same reference when there is nothing to strip", () => {
    const env = { PATH: "/usr/bin" };
    expect(withoutRunnerCredentials(env)).toBe(env);
  });
});

describe("captureRunnerCredentials", () => {
  it("takes the credential out of the environment it was given", () => {
    const env = { PATH: "/usr/bin", [RUNNER_GH_TOKEN]: "ghp_runner" };
    const captured = captureRunnerCredentials(env);

    expect(captured.get(RUNNER_GH_TOKEN)).toBe("ghp_runner");
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("leaves a child spawned with extendEnv no way to see the credential", () => {
    // The reason capture exists. A child spawned with `extendEnv` is given
    // `{ ...process.env, ...env }`, so filtering a COPY does not hide anything:
    // a key merely absent from the copy is not an override and the parent's
    // value wins. Only removing it from the parent works.
    const processEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", [RUNNER_GH_TOKEN]: "ghp_runner" };

    const filteredOnly = { ...processEnv, ...withoutRunnerCredentials(processEnv) };
    expect(filteredOnly[RUNNER_GH_TOKEN]).toBe("ghp_runner");

    captureRunnerCredentials(processEnv);
    const afterCapture = { ...processEnv, ...withoutRunnerCredentials(processEnv) };
    expect(afterCapture[RUNNER_GH_TOKEN]).toBeUndefined();
  });

  it("returns an empty map and changes nothing when none is configured", () => {
    const env = { PATH: "/usr/bin" };
    expect(captureRunnerCredentials(env).size).toBe(0);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("withRunnerSourceControlCredentials", () => {
  const captured = new Map([[RUNNER_GH_TOKEN, "ghp_runner"]]);

  it("maps the runner token onto the variable the CLI reads", () => {
    expect(withRunnerSourceControlCredentials({ PATH: "/usr/bin" }, captured)).toEqual({
      PATH: "/usr/bin",
      GH_TOKEN: "ghp_runner",
    });
  });

  it("does not leave the runner-prefixed original for the tool to pass on", () => {
    const granted = withRunnerSourceControlCredentials({ [RUNNER_GH_TOKEN]: "stale" }, captured);
    expect(granted?.[RUNNER_GH_TOKEN]).toBeUndefined();
  });

  it("overrides an ambient token so the runner's identity is the one used", () => {
    expect(withRunnerSourceControlCredentials({ GH_TOKEN: "ghp_developer" }, captured)).toEqual({
      GH_TOKEN: "ghp_runner",
    });
  });

  it("returns null when no runner credential was captured", () => {
    // Null means "change nothing", which is what keeps every existing install
    // behaving exactly as it did before runner credentials existed.
    expect(withRunnerSourceControlCredentials({ PATH: "/usr/bin" }, new Map())).toBeNull();
    expect(
      withRunnerSourceControlCredentials({ PATH: "/usr/bin" }, new Map([[RUNNER_GH_TOKEN, ""]])),
    ).toBeNull();
  });
});

describe("withOrganizationGithubToken", () => {
  it("fills the GH_TOKEN slot for one child without touching the input", () => {
    const env = { PATH: "/usr/bin" };
    expect(withOrganizationGithubToken(env, "ghs_installation")).toEqual({
      PATH: "/usr/bin",
      GH_TOKEN: "ghs_installation",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps runner-prefixed variables out of the child, like a runner grant does", () => {
    expect(
      withOrganizationGithubToken(
        { PATH: "/usr/bin", [`${RUNNER_CREDENTIAL_ENV_PREFIX}FUTURE_SECRET`]: "x" },
        "ghs_installation",
      ),
    ).toEqual({ PATH: "/usr/bin", GH_TOKEN: "ghs_installation" });
  });
});
