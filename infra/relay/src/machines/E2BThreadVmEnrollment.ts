import { sendThreadVmCommandInput } from "./E2BThreadVmGuestCommand.ts";
import { inspectE2BThreadVmConnection } from "./E2BThreadVmConnection.ts";
import { Sandbox } from "e2b";
import { RelayThreadVmBootstrap, RelayThreadVmEnrollmentReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";

const encodeBootstrap = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmBootstrap));
const decodeReceipt = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayThreadVmEnrollmentReceipt),
);
type Connection = ConstructorParameters<typeof Sandbox>[0];
type GuestEnroll = (
  connection: Connection,
  payload: Redacted.Redacted<string>,
  workflow?: boolean,
) => Promise<string>;
const runGuest: GuestEnroll = async (connection, payload, workflow) => {
  // The pinned SDK's constructor opens a transport only. Sandbox.connect() can
  // resume a paused machine and must not be used by this retryable setup step.
  const vm = new Sandbox(connection);
  const command = await vm.commands.run(
    workflow
      ? "/opt/launchpad/bin/launchpad-workload workflow-enroll"
      : "/usr/bin/flock --no-fork -x /home/user/.launchpad-enrollment.lock /opt/launchpad/server/t3 __thread-vm-enroll --base-dir /home/user/.launchpad",
    {
      user: workflow ? "root" : "user",
      background: true,
      stdin: true,
      timeoutMs: 60_000,
    },
  );
  const result = await sendThreadVmCommandInput(command, Redacted.value(payload));
  if (result.exitCode !== 0) throw new Error("VM enrollment command did not complete");
  return result.stdout;
};

/** Read-only connection discovery plus idempotent guest enrollment; never wakes a VM. */
export function makeE2BThreadVmEnrollment(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  guest: GuestEnroll = runGuest,
) {
  return Effect.fn("relay.thread_vm.deliver_enrollment")(function* (
    sandboxId: string,
    bootstrap: RelayThreadVmBootstrap,
    workflow?: boolean,
  ) {
    const payload = yield* encodeBootstrap(bootstrap).pipe(
      Effect.map(Redacted.make),
      Effect.mapError(
        () =>
          new ThreadVmComputeError({
            operation: "enroll",
            message: "Invalid VM enrollment request.",
          }),
      ),
    );
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const connection = await inspectE2BThreadVmConnection(
          settings,
          sandboxId,
          bootstrap,
          transport,
          signal,
        );
        const output = await guest(connection, payload, workflow);
        const receipt = decodeReceipt(output.trim());
        if (
          receipt.allocationId !== bootstrap.scope.allocationId ||
          receipt.operationId !== bootstrap.operationId ||
          receipt.threadId !== bootstrap.scope.threadId ||
          receipt.generation !== bootstrap.scope.generation
        )
          throw new Error("Enrollment receipt differs");
        return receipt;
      },
      // SDK and guest errors can contain headers/stdin. Persist only this stable diagnostic.
      catch: () =>
        new ThreadVmComputeError({
          operation: "enroll",
          message: "VM enrollment is unconfirmed. Retry the same allocation and identity.",
        }),
    });
  });
}
