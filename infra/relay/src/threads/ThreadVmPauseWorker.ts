import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { ThreadId } from "@t3tools/contracts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo } from "e2b";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import type { PauseClaim } from "./ThreadVmPauseStore.ts";
import { makeThreadVmPauseStore } from "./ThreadVmPauseStore.ts";

type Identity = {
  readonly operationId: string;
  readonly templateId?: string;
  readonly scope: {
    readonly allocationId: string;
    readonly threadId: ReturnType<typeof ThreadId.make>;
    readonly repositoryId: ReturnType<typeof RelayRepositoryId.make>;
    readonly generation: number;
  };
};
interface PauseCompute {
  readonly inspect: (sandboxId: string) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  readonly pause: (sandboxId: string) => Effect.Effect<unknown, ThreadVmComputeError>;
  readonly pausedSnapshotsSupported?: Effect.Effect<boolean>;
}
interface PauseGuest {
  readonly seal: (
    sandboxId: string,
    identity: Identity,
    operationId: string,
  ) => Effect.Effect<{ readonly bootId: string; readonly idle: boolean }, ThreadVmComputeError>;
  readonly reopen: (
    sandboxId: string,
    identity: Identity,
    operationId: string,
  ) => Effect.Effect<unknown, ThreadVmComputeError>;
}

function matches(info: SandboxInfo | null, claim: PauseClaim) {
  return (
    info?.sandboxId === claim.computeRef &&
    info.metadata["launchpad.managed"] === "thread-vm-v1" &&
    info.metadata["launchpad.allocation_id"] === claim.allocationId &&
    threadVmOperationMatches(info.metadata, claim.provisionOperationId) &&
    info.metadata["launchpad.thread_id"] === claim.threadId &&
    info.metadata["launchpad.generation"] === String(claim.generation)
  );
}

/** Reconcile an ambiguous pause by identity and non-waking state inspection. */
export function makeThreadVmPauseWorker(
  sql: PgClient,
  compute: PauseCompute,
  guest: PauseGuest,
  hostId: string,
) {
  const store = makeThreadVmPauseStore(sql);
  const runOne = Effect.fn("relay.thread_vm.pause.run_one")(function* () {
    // Older hosts report "paused" for a lost route even when the disk build failed.
    if (compute.pausedSnapshotsSupported && !(yield* compute.pausedSnapshotsSupported))
      return false;
    yield* store.reserveIdle(hostId);
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    const identity: Identity = {
      operationId: claim.provisionOperationId,
      templateId: claim.templateId,
      scope: {
        allocationId: claim.allocationId,
        threadId: ThreadId.make(claim.threadId),
        repositoryId: RelayRepositoryId.make(claim.repositoryId),
        generation: claim.generation,
      },
    };
    const attempt = Effect.gen(function* () {
      const before = yield* compute.inspect(claim.computeRef);
      if (!before || !matches(before, claim)) return;
      if (before.state === "paused") {
        // Timeout may stop the exact VM after its source checkpoint was
        // retained but before this worker records the guest seal.
        if (claim.phase === "pending" && !(yield* store.markSealed(claim, claim.bootId))) return;
        yield* store.finish(claim);
        return;
      }
      if (before.state !== "running") return;
      const seal = yield* guest.seal(claim.computeRef, identity, claim.operationId);
      // A fresh boot cannot certify the conversation captured by the old server.
      if (seal.bootId !== claim.bootId) return;
      if (!seal.idle) {
        yield* guest.reopen(claim.computeRef, identity, claim.operationId);
        yield* store.cancel(claim);
        return;
      }
      if (!(yield* store.markSealed(claim, seal.bootId))) return;
      yield* compute.pause(claim.computeRef);
      const after = yield* compute.inspect(claim.computeRef);
      if (after && matches(after, claim) && after.state === "paused") yield* store.finish(claim);
    });
    yield* attempt.pipe(
      Effect.catchTag("ThreadVmComputeError", () => Effect.void),
      Effect.andThen(store.defer(claim)),
    );
    return true;
  });
  return { runOne };
}
