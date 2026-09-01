/**
 * Where the runner's source-control credential lives once it is out of the
 * process environment.
 *
 * The capture runs at module load — this module is in the server's import
 * graph, so it happens before any child process can be spawned — and it is the
 * whole guarantee. Filtering the credential out of each provider's environment
 * is not enough on its own: a child spawned with `extendEnv` merges
 * `{ ...process.env, ...env }`, so a key that is merely absent from the
 * filtered copy is not an override and the parent's value reaches the child
 * anyway. Taking it out of `process.env` removes it from every descendant at
 * once, whatever any individual spawn site does.
 *
 * @module vcs/runnerCredentials
 */
import {
  captureRunnerCredentials,
  withOrganizationGithubToken,
  withRunnerSourceControlCredentials,
} from "@t3tools/shared/runnerCredentials";

const capturedRunnerCredentials = captureRunnerCredentials(globalThis.process.env);

/**
 * The environment a runner-initiated source-control subprocess should run
 * with, or `null` to leave the inherited environment untouched.
 *
 * A runner token the operator configured on this machine always wins. The
 * organization's GitHub installation token, when a managed executor has one
 * (ADR-0015), fills the slot only when no such token exists.
 */
export function runnerSourceControlEnv(
  baseEnv: NodeJS.ProcessEnv,
  organizationGithubToken: string | null = null,
): NodeJS.ProcessEnv | null {
  const local = withRunnerSourceControlCredentials(baseEnv, capturedRunnerCredentials);
  if (local !== null || organizationGithubToken === null) {
    return local;
  }
  return withOrganizationGithubToken(baseEnv, organizationGithubToken);
}

/** Whether a runner credential was configured on this machine. */
export function hasRunnerSourceControlCredential(): boolean {
  return capturedRunnerCredentials.size > 0;
}
