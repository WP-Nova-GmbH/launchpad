import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { LinearWorkflowConfiguration } from "../Config.ts";
import type { makeE2BRestoreClient } from "../machines/E2BRestoreClient.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";

/** Catalog validation is read-only. A native snapshot starts only after ownership commits. */
export function makeThreadVmRestoreWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: Pick<ReturnType<typeof makeE2BRestoreClient>, "resolveSource">,
  hostId: string,
  workflowEnabled?: boolean,
  linearWorkflow?: LinearWorkflowConfiguration,
) {
  const store = makeThreadVmRestoreStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.restore.prepare_one")(function* () {
    yield* makeThreadVmCapacityStore(sql).admitNext(
      hostId,
      workflowEnabled === undefined
        ? "personal"
        : { workflowEnabled, ...(linearWorkflow ? { linearWorkflow } : {}) },
    );
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      if (claim.phase === "aborting") {
        yield* store.completeAbort(claim);
        return;
      }
      const row = yield* store.beginPrepare(claim);
      const source = yield* compute.resolveSource(row.sourceTemplateId, row.sourceBuildId);
      yield* store.recordPrepared(claim, {
        version: 1,
        kind: "native-restore-catalog-v1",
        sourceTemplateId: source.sourceTemplateID,
        sourceBuildId: source.sourceBuildID,
      });
    }).pipe(
      Effect.catchTags({
        E2BRestoreError: () => store.defer(claim, "snapshot_unconfirmed"),
        ThreadVmRestoreConflict: () => store.defer(claim, "recovery_unconfirmed"),
        ThreadNativeCheckpointConflict: () => store.defer(claim, "recovery_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
