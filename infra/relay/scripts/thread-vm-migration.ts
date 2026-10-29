// @effect-diagnostics nodeBuiltinImport:off - This operator command writes a private inventory file.
import * as NodeFSP from "node:fs/promises";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  makeThreadVmMigrationInventory,
  MigrationPinId,
} from "../src/threads/ThreadVmMigrationInventory.ts";

const Command = Schema.Union([
  Schema.Tuple([Schema.Literal("inventory"), Schema.NonEmptyString, Schema.NonEmptyString]),
  Schema.Tuple([
    Schema.Literals(["protect", "release"]),
    Schema.NonEmptyString,
    MigrationPinId,
    Schema.NonEmptyString,
    Schema.Literal("--workers-stopped"),
  ]),
]);
const decodeCommand = Schema.decodeUnknownExit(Command);
const encodeReport = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// A dedicated DSN and fresh output path prevent silently touching the dev relay or overwriting an earlier inventory.
export async function main(args = process.argv.slice(2)) {
  const parsed = decodeCommand(args);
  const url = process.env.E2B_MIGRATION_RELAY_DATABASE_URL;
  if (parsed._tag === "Failure" || !url) {
    process.stderr.write(
      "Set E2B_MIGRATION_RELAY_DATABASE_URL explicitly. Usage:\n" +
        "  node scripts/thread-vm-migration.ts inventory <host-id> <new-output.json>\n" +
        "  node scripts/thread-vm-migration.ts protect|release <host-id> <e2b-migration-name> <new-output.json> --workers-stopped\n" +
        "Stop and drain relay VM workers and the compute-host collector before changing pins. " +
        "Releasing pins may make overdue native saved disks eligible for expiry; legacy roots remain quarantined. " +
        "This command never stops services or verifies stock E2B compatibility.\n",
    );
    process.exitCode = 1;
    return;
  }
  const command = parsed.value;
  const output = command[0] === "inventory" ? command[2] : command[3];
  let file: Awaited<ReturnType<typeof NodeFSP.open>>;
  try {
    file = await NodeFSP.open(output, "wx", 0o600);
  } catch {
    process.stderr.write(
      "Cannot create the inventory file. Choose a new path in an existing directory.\n",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = makeThreadVmMigrationInventory(yield* PgClient.PgClient);
        if (command[0] === "inventory") return yield* store.inventory(command[1]);
        const input = { hostId: command[1], pinId: command[2] };
        return command[0] === "protect" ? yield* store.protect(input) : yield* store.release(input);
      }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))),
    );
    await file.writeFile(encodeReport(result) + "\n");
    process.stdout.write(
      `Saved relay catalogue ${command[0]} report to ${output}. ` +
        "Host quiescence and stock E2B compatibility remain unverified.\n",
    );
  } catch {
    // SQL/connection errors may contain the DSN; never echo them from this credential-bearing command.
    process.stderr.write(
      "Migration command failed. No host services were changed. " +
        "Run inventory with a new output path; a successful pin transaction can be repeated with the same pin name.\n",
    );
    process.exitCode = 1;
  } finally {
    await file.close();
  }
}

if (import.meta.main) await main();
