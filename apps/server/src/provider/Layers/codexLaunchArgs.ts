import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";
export const MANAGED_CODEX_MODEL_PROVIDER = "launchpad_vm";
const MANAGED_CODEX_DEFAULT_MODEL = "gpt-6-astra";
export const MANAGED_CODEX_MODELS = new Set([
  "gpt-6.1-sol",
  MANAGED_CODEX_DEFAULT_MODEL,
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export const managedCodexModelIssue = (model: string) =>
  MANAGED_CODEX_MODELS.has(model)
    ? undefined
    : `The organization's Codex connection does not support '${model}'. Select a supported model before continuing this conversation.`;

/** Replace the entire provider table so an inherited env_key or bearer cannot become a fallback. */
const managedCodexProviderArgs = (
  baseUrl: string,
  authCommand: string,
  authArgs: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "-c",
  `model_provider="${MANAGED_CODEX_MODEL_PROVIDER}"`,
  "-c",
  `model="${MANAGED_CODEX_DEFAULT_MODEL}"`,
  "-c",
  `model_providers.${MANAGED_CODEX_MODEL_PROVIDER}={name="Organization Codex",base_url=${JSON.stringify(baseUrl)},wire_api="responses",requires_openai_auth=false,supports_websockets=false,auth={command=${JSON.stringify(authCommand)},args=${JSON.stringify(authArgs)},timeout_ms=10000,refresh_interval_ms=300000}}`,
];

const managedCodexArgs = (connectionId?: string): ReadonlyArray<string> =>
  connectionId
    ? managedCodexProviderArgs("https://api.openai.com/v1", "/opt/launchpad/server/t3", [
        "__thread-vm-codex-token",
        "--connection-id",
        connectionId,
      ])
    : [];

/** Workflow commands run inside Launchpad's isolation rather than a nested Codex sandbox. */
export const workflowCodexSandboxPolicy = () => ({
  type: "externalSandbox" as const,
  networkAccess: "enabled" as const,
});

/** This policy is emitted by the packaged guest for the offline runner smoke probe. */
export const managedCodexModelProbePolicy = () => ({
  schemaVersion: 1 as const,
  defaultModel: MANAGED_CODEX_DEFAULT_MODEL,
  modelSlugs: [...MANAGED_CODEX_MODELS],
  workflowSandboxPolicy: workflowCodexSandboxPolicy(),
  probeArgs: [
    "app-server",
    ...managedCodexProviderArgs("http://127.0.0.1:1/v1", "/usr/bin/false", []),
  ],
});

export const managedCodexEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        ![
          T3CODE_CODEX_LAUNCH_ARGS_ENV,
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "OPENAI_BASE_URL",
        ].includes(key),
    ),
  );

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string, managedConnectionId?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
  ...managedCodexArgs(managedConnectionId),
];

export const codexExecLaunchArgs = (launchArgs?: string, managedConnectionId?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return [...execArgs, ...managedCodexArgs(managedConnectionId)];
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
  managedConnectionId?: string,
  workflowProxy?: { readonly baseUrl: string; readonly permitEnv: string },
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return [
    ...launchAppServerArgs,
    ...(appServerArgs ?? []),
    ...(workflowProxy
      ? managedCodexProviderArgs(workflowProxy.baseUrl, "/usr/bin/printenv", [
          workflowProxy.permitEnv,
        ])
      : managedCodexArgs(managedConnectionId)),
  ];
};
