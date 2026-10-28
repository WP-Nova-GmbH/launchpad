import { RUNNER_CREDENTIAL_ENV_PREFIX } from "@t3tools/shared/runnerCredentials";

export const THREAD_VM_GIT_CREDENTIAL_HELPER =
  "!/usr/local/bin/launchpad-server __thread-vm-git-credential";

/** The helper runs only when Git actually needs HTTP credentials, so offline status/checkpoints remain local. */
export const privateThreadVmGitArgs = (args: ReadonlyArray<string>) => [
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${THREAD_VM_GIT_CREDENTIAL_HELPER}`,
  "-c",
  "credential.useHttpPath=true",
  ...args,
];

/** Explicit empty overrides matter: ProcessRunner extends the parent environment. */
export function privateThreadVmSourceControlEnv(
  base: NodeJS.ProcessEnv,
  token: string | null,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(base)]))
    if (key.startsWith(RUNNER_CREDENTIAL_ENV_PREFIX)) env[key] = "";
  return {
    ...env,
    GH_TOKEN: token ?? "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
    GH_HOST: "github.com",
    GH_CONFIG_DIR: "/home/user/.launchpad/github",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
}
