import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { withoutRunnerCredentials } from "@t3tools/shared/runnerCredentials";

import { expandHomePath } from "../pathExpansion.ts";

/**
 * Builds the environment a provider child process is spawned with.
 *
 * This is the single place every driver funnels through, which makes it the
 * place ADR-0009's "never materialized into an agent's process environment"
 * holds: runner-held credentials are stripped here, so no adapter can leak one
 * by forgetting to.
 */
export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const agentEnv = withoutRunnerCredentials(baseEnv);
  if (!environment || environment.length === 0) {
    return agentEnv;
  }

  const next: NodeJS.ProcessEnv = { ...agentEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}
