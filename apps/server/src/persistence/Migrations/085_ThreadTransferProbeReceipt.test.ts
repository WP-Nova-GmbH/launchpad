import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "./085_ThreadTransferProbeReceipt.ts";

it.effect(
  "recognizes only legacy ready setup success and gives probes unique durable ownership",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE thread_transfer_readiness(operation_id TEXT PRIMARY KEY,phase TEXT NOT NULL,setup_output_json TEXT)`;
      yield* sql`INSERT INTO thread_transfer_readiness VALUES('unknown','started','captured output from failed setup'),('ready','ready',NULL)`;
      yield* migration;
      expect(
        yield* sql`SELECT operation_id,setup_succeeded,provider_probe_attempt_id FROM thread_transfer_readiness ORDER BY operation_id`,
      ).toEqual([
        { operation_id: "ready", setup_succeeded: 1, provider_probe_attempt_id: null },
        { operation_id: "unknown", setup_succeeded: 0, provider_probe_attempt_id: null },
      ]);
      yield* sql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id='owned' WHERE operation_id='ready'`;
      expect(
        yield* sql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id='owned' WHERE operation_id='unknown'`.pipe(
          Effect.isFailure,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
