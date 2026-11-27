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
  recoverable: Schema.optionalKey(Schema.Literal(true)),
  codexOnly: Schema.optionalKey(Schema.Literal(true)),
  groups: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      bootId: Schema.String,
      kind: Schema.Literals(["process", "provider", "terminal", "transfer", "probe"]),
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
    cancelledStopped: Schema.optionalKey(Schema.Literal(true)),
    backgroundBusy: Schema.optionalKey(Schema.Boolean),
    backgroundRevision: Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}(?::stopped)?$/u)),
    ),
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
export function classifyThreadVmActivity(
  inventory: Inventory,
  workflowCheckpoint = false,
  finishedWorkflow = false,
) {
  if (
    inventory.stopped !== (inventory.groups.length === 0) ||
    inventory.groups.some((group) => group.bootId !== inventory.bootId) ||
    new Set(inventory.groups.map((group) => group.id)).size !== inventory.groups.length ||
    inventory.sealedBy !== null
  )
    return "unknown" as const;
  if (workflowCheckpoint) {
    if (inventory.codexOnly === true)
      return finishedWorkflow &&
        inventory.groups.length === 1 &&
        inventory.groups[0]?.kind === "provider"
        ? ("idle" as const)
        : ("unknown" as const);
    return inventory.recoverable === true &&
      inventory.groups.length <= 1 &&
      inventory.groups.every((group) => group.kind === "terminal")
      ? ("idle" as const)
      : ("unknown" as const);
  }
  if (inventory.groups.some((group) => group.kind !== "terminal")) return "busy" as const;
  return inventory.groups.length === 0 ? ("idle" as const) : ("unknown" as const);
}

type InspectGuest = (
  connection: ConstructorParameters<typeof Sandbox>[0],
  workflowCheckpoint: boolean,
) => Promise<string>;
const inspectGuest: InspectGuest = async (connection, workflowCheckpoint) => {
  const vm = new Sandbox(connection);
  const result = await vm.commands.run(
    workflowCheckpoint
      ? "/opt/launchpad/bin/launchpad-activity --workflow"
      : "/opt/launchpad/bin/launchpad-activity",
    {
      user: "user",
      timeoutMs: 10_000,
    },
  );
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
      readonly workflowCheckpoint?: boolean;
      readonly finishedWorkflow?: boolean;
      readonly cancelledWorkflow?: boolean;
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
        const { workloads, projection } = decodeActivity(
          await guest(connection, identity.workflowCheckpoint === true),
        );
        if (
          projection.environmentId !== identity.environmentId ||
          projection.threadId !== identity.scope.threadId ||
          projection.generation !== identity.scope.generation ||
          projection.phase !== "active"
        )
          return "unknown" as const;
        const cancelledStopped = projection.cancelledStopped === true;
        if (
          cancelledStopped &&
          (!identity.cancelledWorkflow ||
            !identity.workflowCheckpoint ||
            !identity.finishedWorkflow ||
            workloads.sealedBy === null ||
            !workloads.stopped ||
            workloads.groups.length !== 0)
        )
          return "unknown" as const;
        const processActivity = cancelledStopped
          ? "idle"
          : classifyThreadVmActivity(
              workloads,
              identity.workflowCheckpoint,
              identity.finishedWorkflow,
            );
        if (processActivity === "unknown") return processActivity;
        if (
          projection.unfinished ||
          (identity.finishedWorkflow === true &&
            (projection.backgroundBusy === true ||
              (workloads.codexOnly === true && projection.backgroundRevision === undefined))) ||
          threadPromptQueueHasWork(projection.queue, projection.archived)
        )
          return "busy" as const;
        const processWorkIds = projection.processWorkIds ?? [];
        if (new Set(processWorkIds).size !== processWorkIds.length) return "unknown" as const;
        // The relay can observe an idle VM while a settled Codex session still
        // holds admissions. The pause drain proves shutdown before releasing them.
        const backgroundRevision =
          identity.finishedWorkflow && !cancelledStopped
            ? projection.backgroundRevision
            : undefined;
        if (processActivity === "idle" && (processWorkIds.length || backgroundRevision))
          return {
            activity: "idle" as const,
            inactiveWorkIds: processWorkIds,
            ...(backgroundRevision ? { backgroundRevision } : {}),
          };
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
