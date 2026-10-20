import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { ThreadId } from "@t3tools/contracts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo } from "e2b";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import type { ResumeClaim } from "./ThreadVmResumeStore.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";

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
interface ResumeCompute {
  readonly inspect: (sandboxId: string) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  readonly resume: (sandboxId: string) => Effect.Effect<unknown, ThreadVmComputeError>;
}
interface ResumeGuest {
  readonly reopenAfterResume: (
    sandboxId: string,
    identity: Identity,
    pauseOperationId: string | null,
  ) => Effect.Effect<unknown, ThreadVmComputeError>;
}
const matches = (info: SandboxInfo | null, claim: ResumeClaim) =>
  info?.sandboxId === claim.computeRef &&
  info.metadata["launchpad.managed"] === "thread-vm-v1" &&
  info.metadata["launchpad.allocation_id"] === claim.allocationId &&
  threadVmOperationMatches(info.metadata, claim.provisionOperationId) &&
  info.metadata["launchpad.thread_id"] === claim.threadId &&
  info.metadata["launchpad.generation"] === String(claim.generation);

/** Resume a paused VM only after FIFO physical capacity admission. */
export function makeThreadVmResumeWorker(
  sql: PgClient,
  compute: ResumeCompute,
  guest: ResumeGuest,
  hostId: string,
) {
  const store = makeThreadVmResumeStore(sql);
  const runOne = Effect.fn("relay.thread_vm.resume.run_one")(function* () {
    yield* makeThreadVmCapacityStore(sql).admitNext(hostId);
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
      yield* store.begin(claim);
      let info = yield* compute.inspect(claim.computeRef);
      if (!info || !matches(info, claim)) return;
      if (info.state === "paused") {
        yield* compute.resume(claim.computeRef);
        info = yield* compute.inspect(claim.computeRef);
      }
      if (!info || !matches(info, claim) || info.state !== "running") return;
      if (!(yield* store.finishPower(claim))) return;
      yield* guest.reopenAfterResume(claim.computeRef, identity, claim.pauseOperationId);
      yield* store.complete(claim);
    });
    yield* attempt.pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => Effect.void,
        ThreadVmResumeConflict: () => Effect.void,
      }),
      Effect.andThen(store.defer(claim)),
    );
    return true;
  });
  return { runOne };
}
