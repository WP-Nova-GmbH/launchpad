/**
 * Credentials the job runner holds and agents must never see.
 *
 * ADR-0009 makes irreversible operations — push, open a pull request — the job
 * runner's job rather than an agent's, and requires the credentials for them to
 * be "runner-held and never materialized into an agent's process environment".
 *
 * The mechanism is a name split. The runner's credential is configured under a
 * `T3CODE_RUNNER_`-prefixed variable that no CLI reads on its own, and is
 * mapped to the name the CLI expects only when the server spawns that CLI
 * itself. Provider child processes get the prefix stripped, so the value is not
 * present in any environment an agent can read — including via
 * `/proc/<pid>/environ`.
 *
 * This does not, and cannot, take away an ambient `gh auth login` on a
 * developer's own machine: that is the machine owner's credential, not the
 * runner's. On a provisioned executor there is no ambient login, so the
 * runner's token is the only source of push access and the isolation is total.
 */

/**
 * Every variable carrying a runner-held secret starts with this. Stripping by
 * prefix rather than by an explicit list means a credential added later is
 * agent-invisible by default instead of by remembering to update two places.
 */
export const RUNNER_CREDENTIAL_ENV_PREFIX = "T3CODE_RUNNER_";

/**
 * Runner-held credential → the variable the corresponding CLI actually reads.
 * Only what M0 needs: `gh`, for push and pull-request creation.
 */
export const RUNNER_SOURCE_CONTROL_TOKEN_ENV_VARS: ReadonlyArray<{
  readonly runnerVariable: string;
  readonly toolVariable: string;
}> = [{ runnerVariable: `${RUNNER_CREDENTIAL_ENV_PREFIX}GH_TOKEN`, toolVariable: "GH_TOKEN" }];

/**
 * Take the runner's credentials out of an environment, returning them and
 * removing them from `env` in place.
 *
 * This is the load-bearing half of the guarantee, and filtering a copy is not
 * a substitute for it. A child spawned with `extendEnv` merges as
 * `{ ...process.env, ...env }`, so a key merely *absent* from the filtered copy
 * is not an override — the original value survives and reaches the child. The
 * only way to be sure no descendant inherits the credential is for the parent
 * not to hold it either.
 *
 * Call once, as early in startup as possible.
 */
export function captureRunnerCredentials(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> {
  const captured = new Map<string, string>();
  for (const name of Object.keys(env)) {
    if (!name.startsWith(RUNNER_CREDENTIAL_ENV_PREFIX)) {
      continue;
    }
    const value = env[name];
    if (value !== undefined && value.length > 0) {
      captured.set(name, value);
    }
    delete env[name];
  }
  return captured;
}

/**
 * Strip runner-held credentials from an environment about to be handed to a
 * process that runs agent-authored code.
 *
 * Defence in depth behind `captureRunnerCredentials`: once the credential has
 * been taken out of `process.env` there is nothing here to remove, but this
 * still holds if one is set later in the process's life.
 */
export function withoutRunnerCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let stripped: NodeJS.ProcessEnv | null = null;
  for (const name of Object.keys(env)) {
    if (!name.startsWith(RUNNER_CREDENTIAL_ENV_PREFIX)) {
      continue;
    }
    stripped ??= { ...env };
    delete stripped[name];
  }
  return stripped ?? env;
}

/**
 * Resolve the environment a runner-initiated source-control subprocess should
 * run with, or `null` when no runner credential is configured.
 *
 * Credentials come from the captured map rather than from `env`, because by
 * this point they are deliberately no longer in the process environment.
 *
 * `null` means "change nothing": the caller keeps whatever environment it would
 * have used, so a machine without a runner token behaves exactly as before.
 */
export function withRunnerSourceControlCredentials(
  env: NodeJS.ProcessEnv,
  credentials: ReadonlyMap<string, string>,
): NodeJS.ProcessEnv | null {
  let granted: NodeJS.ProcessEnv | null = null;
  for (const { runnerVariable, toolVariable } of RUNNER_SOURCE_CONTROL_TOKEN_ENV_VARS) {
    const value = credentials.get(runnerVariable);
    if (value === undefined || value.length === 0) {
      continue;
    }
    granted ??= { ...env };
    granted[toolVariable] = value;
  }
  if (granted === null) {
    return null;
  }
  // The runner-prefixed originals are not needed by the tool and would be
  // inherited by anything it spawns, so they come back out here too.
  return withoutRunnerCredentials(granted);
}

/**
 * Grant an organization's GitHub App installation token to a runner-initiated
 * source-control subprocess. Fills the same `GH_TOKEN` slot as a runner-held
 * token would, and like it never enters the server's own environment — the
 * caller hands it to one child and lets it go.
 */
export function withOrganizationGithubToken(
  env: NodeJS.ProcessEnv,
  token: string,
): NodeJS.ProcessEnv {
  return withoutRunnerCredentials({ ...env, GH_TOKEN: token });
}
