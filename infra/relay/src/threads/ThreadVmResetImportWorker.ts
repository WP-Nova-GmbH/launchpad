import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { makeE2BThreadVmRestoreImport } from "../machines/E2BThreadVmRestoreImport.ts";
import type { makeE2BThreadVmServer } from "../machines/E2BThreadVmServer.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { makeThreadVmResetImportStore } from "./ThreadVmResetImportStore.ts";
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmRestoreImportReceipt));
export function makeThreadVmResetImportWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  deliver: ReturnType<typeof makeE2BThreadVmRestoreImport>,
  start: ReturnType<typeof makeE2BThreadVmServer>,
  hostId: string,
) {
  const store = makeThreadVmResetImportStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.reset.import_one")(function* () {
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      const row = yield* store.authorize(claim),
        identity = { operationId: row.operationId, scope: row.scope };
      const receipt =
        row.receipt ??
        (yield* deliver(row.computeRef, row.environmentId, identity).pipe(
          Effect.timeout("60 seconds"),
        ));
      if (!row.receipt) yield* store.record(claim, receipt);
      // Recheck access and credential after import networking, before launching any server.
      yield* store.authorize(claim);
      const digest = yield* (yield* Crypto.Crypto).digest(
        "SHA-256",
        new TextEncoder().encode(yield* encodeReceipt(receipt)),
      );
      yield* start(
        row.computeRef,
        identity,
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        "restore",
      ).pipe(Effect.timeout("45 seconds"));
      yield* store.authorize(claim);
      yield* store.defer(claim, null);
    }).pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => store.defer(claim, "import_unconfirmed"),
        ThreadVmResetConflict: () => store.defer(claim, "readiness_unconfirmed"),
        ThreadNativeCheckpointConflict: () => store.defer(claim, "recovery_unconfirmed"),
        RelayTenancyNotFoundError: () => store.defer(claim, "reset_access_denied"),
        SchemaError: () => store.defer(claim, "readiness_unconfirmed"),
        TimeoutError: () => store.defer(claim, "import_unconfirmed"),
        RelayInternalError: () => store.defer(claim, "import_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
