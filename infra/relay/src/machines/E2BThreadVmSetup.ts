import { Sandbox } from "e2b";
import { RelayThreadVmSetupInput, RelayThreadVmSetupReply } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { inspectE2BThreadVmConnection } from "./E2BThreadVmConnection.ts";

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupInput));
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(RelayThreadVmSetupReply));
type GuestSetup = (
  connection: ConstructorParameters<typeof Sandbox>[0],
  payload: Redacted.Redacted<string>,
) => Promise<string>;
const runGuest: GuestSetup = async (connection, payload) => {
  const vm = new Sandbox(connection);
  const command = await vm.commands.run(
    "launchpad-server __thread-vm-setup --base-dir /home/user/.launchpad",
    {
      user: "user",
      background: true,
      stdin: true,
      timeoutMs: 20 * 60_000,
    },
  );
  await command.sendStdin(Redacted.value(payload) + "\n");
  const result = await command.wait();
  if (result.exitCode !== 0) throw new Error("VM preparation did not return a receipt");
  return result.stdout;
};

/** A lost transport response leaves the guest's durable setup claim in place; no script replay. */
export function makeE2BThreadVmSetup(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  guest: GuestSetup = runGuest,
) {
  return Effect.fn("relay.thread_vm.prepare_guest")(function* (
    sandboxId: string,
    environmentId: string,
    input: RelayThreadVmSetupInput & { readonly templateId?: string },
  ) {
    const payload = yield* encodeInput(input).pipe(
      Effect.map(Redacted.make),
      Effect.mapError(
        () =>
          new ThreadVmComputeError({
            operation: "setup",
            message: "Invalid VM preparation request.",
          }),
      ),
    );
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const connection = await inspectE2BThreadVmConnection(
          settings,
          sandboxId,
          { ...input.workspace, ...(input.templateId ? { templateId: input.templateId } : {}) },
          transport,
          signal,
        );
        const reply = decodeReply((await guest(connection, payload)).trim());
        if (reply.status === "prepared") {
          const { receipt } = reply;
          const { scope } = input.workspace;
          if (
            receipt.environmentId !== environmentId ||
            receipt.operationId !== input.workspace.operationId ||
            receipt.scope.allocationId !== scope.allocationId ||
            receipt.scope.threadId !== scope.threadId ||
            receipt.scope.repositoryId !== scope.repositoryId ||
            receipt.scope.generation !== scope.generation ||
            receipt.projectId !== `vm:${scope.threadId}` ||
            receipt.workspaceRoot !== "/workspace/project" ||
            receipt.revision !== input.workspace.revision
          )
            throw new Error("VM preparation receipt differs");
        }
        return reply;
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "setup",
          message: "VM preparation is unconfirmed. The allocation remains held.",
        }),
    });
  });
}
