import { Sandbox } from "e2b";
import { threadPromptQueueHasWork } from "@t3tools/shared/threadPromptQueue";
import type { RelayThreadVmBootstrap } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { inspectE2BThreadVmConnection } from "./E2BThreadVmConnection.ts";

const Inventory = Schema.Struct({
  bootId: Schema.String,
  sealedBy: Schema.NullOr(Schema.String),
  stopped: Schema.Boolean,
  groups: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      bootId: Schema.String,
      kind: Schema.Literals(["process", "provider", "terminal", "transfer"]),
    }),
  ),
});
type Inventory = typeof Inventory.Type;
const Activity = Schema.Struct({
  workloads: Inventory,
  projection: Schema.Struct({
    threadId: Schema.String,
    environmentId: Schema.String,
    generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    phase: Schema.Literals(["active", "draining", "frozen", "retired"]),
    archived: Schema.Boolean,
    unfinished: Schema.Boolean,
    processWorkIds: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isPattern(/^(provider|terminal|setup):.+$/u))),
    ),
    queue: Schema.Struct({
      enabled: Schema.Boolean,
      handoff: Schema.NullOr(Schema.Boolean),
      awaitingTurnId: Schema.NullOr(Schema.Boolean),
      preparation: Schema.optional(
        Schema.Struct({
          state: Schema.Literals(["pending", "running", "ready", "failed"]),
          settled: Schema.Boolean,
        }),
      ),
      entries: Schema.Array(
        Schema.Struct({
          state: Schema.Literals([
            "pending",
            "delivering",
            "unknown",
            "moving",
            "blocked",
            "cancelling",
          ]),
        }),
      ),
    }),
  }),
});
const decodeActivity = Schema.decodeUnknownSync(Schema.fromJsonString(Activity));

/** An idle terminal shell needs a separate process/PTY signal; do not guess from its cgroup. */
export function classifyThreadVmActivity(inventory: Inventory) {
  if (
    inventory.stopped !== (inventory.groups.length === 0) ||
    inventory.groups.some((group) => group.bootId !== inventory.bootId) ||
    new Set(inventory.groups.map((group) => group.id)).size !== inventory.groups.length ||
    inventory.sealedBy !== null
  )
    return "unknown" as const;
  if (inventory.groups.some((group) => group.kind !== "terminal")) return "busy" as const;
  return inventory.groups.length === 0 ? ("idle" as const) : ("unknown" as const);
}

type InspectGuest = (connection: ConstructorParameters<typeof Sandbox>[0]) => Promise<string>;
const inspectGuest: InspectGuest = async (connection) => {
  const vm = new Sandbox(connection);
  const result = await vm.commands.run("/usr/local/bin/launchpad-activity", {
    user: "user",
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error("VM workload inventory is unavailable");
  return result.stdout;
};

/** Reads a running guest without the SDK's waking connect helper. */
export function makeE2BThreadVmActivity(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  guest: InspectGuest = inspectGuest,
) {
  return Effect.fn("relay.thread_vm.inspect_activity")(function* (
    sandboxId: string,
    identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId"> & {
      readonly environmentId: string;
    },
  ) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const connection = await inspectE2BThreadVmConnection(
          settings,
          sandboxId,
          identity,
          transport,
          signal,
        );
        const { workloads, projection } = decodeActivity(await guest(connection));
        if (
          projection.environmentId !== identity.environmentId ||
          projection.threadId !== identity.scope.threadId ||
          projection.generation !== identity.scope.generation ||
          projection.phase !== "active"
        )
          return "unknown" as const;
        const processActivity = classifyThreadVmActivity(workloads);
        if (processActivity === "unknown") return processActivity;
        if (
          projection.unfinished ||
          threadPromptQueueHasWork(projection.queue, projection.archived)
        )
          return "busy" as const;
        const processWorkIds = projection.processWorkIds ?? [];
        if (new Set(processWorkIds).size !== processWorkIds.length) return "unknown" as const;
        // A settled turn closes its native writer, but its admissions remain held
        // until lifecycle drain. Only an empty kernel inventory can supersede them
        // for idle observation; this does not complete or release execution.
        if (processActivity === "idle" && processWorkIds.length)
          return { activity: "idle" as const, inactiveWorkIds: processWorkIds };
        return processActivity;
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "activity",
          message: "VM workload activity could not be confirmed.",
        }),
    });
  });
}
