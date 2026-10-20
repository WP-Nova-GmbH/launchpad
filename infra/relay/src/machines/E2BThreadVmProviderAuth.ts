import { Sandbox } from "e2b";
import { ThreadId } from "@t3tools/contracts";
import { RelayThreadVmProviderAuth, ThreadVmProviderAuthControl } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { inspectE2BThreadVmConnection } from "./E2BThreadVmConnection.ts";
import { sendThreadVmCommandInput } from "./E2BThreadVmGuestCommand.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(ThreadVmProviderAuthControl));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(RelayThreadVmProviderAuth));
type Guest = (
  connection: ConstructorParameters<typeof Sandbox>[0],
  payload: string,
) => Promise<string>;
const guest: Guest = async (connection, payload) => {
  const vm = new Sandbox(connection);
  const command = await vm.commands.run("launchpad-server __thread-vm-provider-auth", {
    user: "user",
    background: true,
    stdin: true,
    timeoutMs: 45_000,
  });
  const result = await sendThreadVmCommandInput(command, payload);
  if (result.exitCode !== 0) throw new Error("Provider sign-in control is unavailable");
  return result.stdout;
};

/** Fixed private management command. Inspection never resumes a paused guest. */
export function makeE2BThreadVmProviderAuth(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  runGuest: Guest = guest,
) {
  return Effect.fn("relay.thread_vm.provider_auth")(function* (input: {
    threadId: string;
    repositoryId: string;
    computeRef: string;
    templateId: string;
    control: ThreadVmProviderAuthControl;
  }) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const binding = input.control.binding;
        const connection = await inspectE2BThreadVmConnection(
          settings,
          input.computeRef,
          {
            operationId: binding.operationId,
            templateId: input.templateId,
            scope: {
              allocationId: binding.allocationId,
              threadId: ThreadId.make(input.threadId),
              repositoryId: input.repositoryId,
              generation: binding.generation,
            },
          },
          transport,
          signal,
        );
        const result = decode((await runGuest(connection, encode(input.control))).trim());
        if (
          result.operationId !== binding.operationId ||
          result.allocationId !== binding.allocationId ||
          result.environmentId !== binding.environmentId ||
          result.generation !== binding.generation ||
          result.instanceId !== "codex" ||
          result.auth.instanceId !== "codex"
        )
          throw new Error("Provider sign-in identity changed");
        return result;
      },
      // E2B errors may include transport secrets; do not expose or persist them.
      catch: () =>
        new ThreadVmComputeError({
          operation: "startup",
          message: "VM sign-in is unavailable. Retry while the VM is being prepared.",
        }),
    });
  });
}
