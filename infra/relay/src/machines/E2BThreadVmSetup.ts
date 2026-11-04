import { Sandbox } from "e2b";
import {
  RelayThreadVmCheckoutFailureProbe,
  RelayThreadVmCheckoutFailureReply,
  RelayThreadVmSetupInput,
  RelayThreadVmSetupReply,
  RelayThreadVmWorkflowSetupEnvelope,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { inspectE2BThreadVmConnection, type E2BThreadVmIdentity } from "./E2BThreadVmConnection.ts";

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupInput));
const encodeWorkflowInput = Schema.encodeEffect(
  Schema.fromJsonString(RelayThreadVmWorkflowSetupEnvelope),
);
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(RelayThreadVmSetupReply));
const encodeCheckoutProbe = Schema.encodeEffect(
  Schema.fromJsonString(RelayThreadVmCheckoutFailureProbe),
);
const decodeCheckoutFailure = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayThreadVmCheckoutFailureReply),
);
type GuestSetup = (
  connection: ConstructorParameters<typeof Sandbox>[0],
  payload: Redacted.Redacted<string>,
  probe?: { readonly signal: AbortSignal },
) => Promise<string>;
const runGuest: GuestSetup = async (connection, payload, probe) => {
  const vm = new Sandbox(connection);
  const command = await vm.commands.run(
    "/opt/launchpad/server/t3 __thread-vm-setup --base-dir /home/user/.launchpad" +
      (probe ? " --recover-checkout-failure" : ""),
    {
      user: "user",
      background: true,
      stdin: true,
      timeoutMs: probe ? 5_000 : 20 * 60_000,
      ...(probe ? { signal: probe.signal } : {}),
    },
  );
  await command.sendStdin(Redacted.value(payload) + "\n", probe);
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
  const invalidInput = () =>
    new ThreadVmComputeError({ operation: "setup", message: "Invalid VM preparation request." });
  const invoke = <A>(
    sandboxId: string,
    identity: E2BThreadVmIdentity,
    payload: Redacted.Redacted<string>,
    decode: (stdout: string) => A,
    probe = false,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const connection = await inspectE2BThreadVmConnection(
          settings,
          sandboxId,
          identity,
          transport,
          signal,
        );
        return decode((await guest(connection, payload, probe ? { signal } : undefined)).trim());
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "setup",
          message: "VM preparation is unconfirmed. The allocation remains held.",
        }),
    });
  const prepare = Effect.fn("relay.thread_vm.prepare_guest")(function* (
    sandboxId: string,
    environmentId: string,
    input: RelayThreadVmSetupInput & { readonly templateId?: string },
    gitToken?: Redacted.Redacted<string>,
  ) {
    const payload = yield* (
      gitToken ? encodeWorkflowInput({ input, gitToken }) : encodeInput(input)
    ).pipe(Effect.map(Redacted.make), Effect.mapError(invalidInput));
    return yield* invoke(
      sandboxId,
      { ...input.workspace, ...(input.templateId ? { templateId: input.templateId } : {}) },
      payload,
      (stdout) => {
        const reply = decodeReply(stdout);
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
    );
  });
  const recoverCheckoutFailure = Effect.fn("relay.thread_vm.recover_checkout_failure")(function* (
    sandboxId: string,
    { templateId, ...request }: RelayThreadVmCheckoutFailureProbe & { readonly templateId: string },
  ) {
    const payload = yield* encodeCheckoutProbe(request).pipe(
      Effect.map(Redacted.make),
      Effect.mapError(invalidInput),
    );
    return yield* invoke(
      sandboxId,
      { ...request.workspace, templateId },
      payload,
      (stdout) => decodeCheckoutFailure(stdout).failureCode,
      true,
    );
  });
  return { prepare, recoverCheckoutFailure };
}
