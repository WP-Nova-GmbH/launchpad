import type {
  RelayMachineComputeKind,
  RelayMachineRole,
  RelayMachineStatus,
  RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import { and, eq, isNull, sql as drizzleSql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayMachines } from "../persistence/schema.ts";

/** How long a provisioned machine has to boot and call home before its seed dies. */
export const MACHINE_SEED_EXPIRY_HOURS = 24;

/**
 * The per-instance enrollment seed (ADR-0002). Generated once, injected into
 * the machine's compute, and stored here only as a hash — like invitation
 * tokens, the relay has no reason to be able to reproduce one.
 */
export const makeMachineSeed = (crypto: Crypto.Crypto) =>
  crypto.randomBytes(32).pipe(Effect.map((bytes) => `t3mseed_${Encoding.encodeHex(bytes)}`));

export const hashMachineSeed = (crypto: Crypto.Crypto, seed: string) =>
  crypto
    .digest("SHA-256", new TextEncoder().encode(seed))
    .pipe(Effect.map(Encoding.encodeBase64Url));

/**
 * The synthetic owner key under which a machine's managed endpoint is
 * allocated. The endpoint tables key on `user_id`, and renaming that column
 * would drop-and-create it through the migration pipeline; machines instead
 * occupy the same tables under `org:<organizationId>`, which can never collide
 * with a Clerk subject id.
 */
export function machineEndpointOwnerKey(organizationId: string): string {
  return `org:${organizationId}`;
}

export interface MachineRecord {
  readonly machineId: string;
  readonly organizationId: string;
  readonly role: RelayMachineRole;
  readonly label: string;
  readonly computeKind: RelayMachineComputeKind;
  readonly computeRef: string | null;
  readonly seedExpiresAt: string;
  readonly environmentId: string | null;
  readonly environmentPublicKey: string | null;
  readonly endpointHttpBaseUrl: string | null;
  readonly endpointWsBaseUrl: string | null;
  readonly endpointProviderKind: string | null;
  readonly createdByUserId: string;
  readonly enrolledAt: string | null;
  readonly deprovisionedAt: string | null;
  readonly createdAt: string;
}

export function machineStatus(record: MachineRecord): RelayMachineStatus {
  if (record.deprovisionedAt !== null) {
    return "deprovisioned";
  }
  return record.enrolledAt !== null ? "ready" : "awaiting_enrollment";
}

export class MachinePersistenceError extends Schema.TaggedErrorClass<MachinePersistenceError>()(
  "MachinePersistenceError",
  {
    operation: Schema.Literals([
      "create-machine",
      "load-machine",
      "list-machines",
      "count-machines",
      "load-by-seed",
      "load-by-environment",
      "record-compute-ref",
      "claim-enrollment",
      "deprovision-machine",
      "remove-machine",
    ]),
    machineId: Schema.optionalKey(Schema.String),
    organizationId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Machine '${this.operation}' failed`;
  }
}

const machineSelection = {
  machineId: relayMachines.machineId,
  organizationId: relayMachines.organizationId,
  role: relayMachines.role,
  label: relayMachines.label,
  computeKind: relayMachines.computeKind,
  computeRef: relayMachines.computeRef,
  seedExpiresAt: relayMachines.seedExpiresAt,
  environmentId: relayMachines.environmentId,
  environmentPublicKey: relayMachines.environmentPublicKey,
  endpointHttpBaseUrl: relayMachines.endpointHttpBaseUrl,
  endpointWsBaseUrl: relayMachines.endpointWsBaseUrl,
  endpointProviderKind: relayMachines.endpointProviderKind,
  createdByUserId: relayMachines.createdByUserId,
  enrolledAt: relayMachines.enrolledAt,
  deprovisionedAt: relayMachines.deprovisionedAt,
  createdAt: relayMachines.createdAt,
};

export class Machines extends Context.Service<
  Machines,
  {
    readonly create: (input: {
      readonly machineId: string;
      readonly organizationId: string;
      readonly role: RelayMachineRole;
      readonly label: string;
      readonly computeKind: RelayMachineComputeKind;
      readonly seedHash: string;
      readonly seedExpiresAt: string;
      readonly createdByUserId: string;
    }) => Effect.Effect<MachineRecord, MachinePersistenceError>;
    readonly getById: (input: {
      readonly machineId: string;
    }) => Effect.Effect<MachineRecord | null, MachinePersistenceError>;
    readonly listForOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<ReadonlyArray<MachineRecord>, MachinePersistenceError>;
    /** Machines that count against the quota: everything not deprovisioned. */
    readonly countActiveForOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<number, MachinePersistenceError>;
    readonly getBySeedHash: (input: {
      readonly seedHash: string;
    }) => Effect.Effect<MachineRecord | null, MachinePersistenceError>;
    readonly getActiveByEnvironmentId: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<MachineRecord | null, MachinePersistenceError>;
    readonly recordComputeRef: (input: {
      readonly machineId: string;
      readonly computeRef: string;
    }) => Effect.Effect<void, MachinePersistenceError>;
    /**
     * The single-use gate of enrollment: records the machine's environment
     * identity and endpoint only while the machine is unenrolled and not
     * deprovisioned. A second enrollment attempt finds nothing left to claim.
     */
    readonly claimEnrollment: (input: {
      readonly machineId: string;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<boolean, MachinePersistenceError>;
    /** Tombstones the machine; the record survives as history. */
    readonly deprovision: (input: {
      readonly machineId: string;
    }) => Effect.Effect<boolean, MachinePersistenceError>;
    /** Hard delete, only for a machine whose compute was never created. */
    readonly remove: (input: {
      readonly machineId: string;
    }) => Effect.Effect<void, MachinePersistenceError>;
  }
>()("t3code-relay/machines/Machines") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return Machines.of({
    create: Effect.fn("relay.machines.create")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.organization_id": input.organizationId,
        "relay.machine_id": input.machineId,
        "relay.machine.role": input.role,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .insert(relayMachines)
        .values({
          machineId: input.machineId,
          organizationId: input.organizationId,
          role: input.role,
          label: input.label,
          computeKind: input.computeKind,
          computeRef: null,
          seedHash: input.seedHash,
          seedExpiresAt: input.seedExpiresAt,
          createdByUserId: input.createdByUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning(machineSelection)
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachinePersistenceError({
                operation: "create-machine",
                machineId: input.machineId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return yield* new MachinePersistenceError({
          operation: "create-machine",
          machineId: input.machineId,
          organizationId: input.organizationId,
          cause: "machine insert returned no row",
        });
      }
      return row;
    }),

    getById: Effect.fn("relay.machines.get_by_id")(function* (input) {
      const rows = yield* db
        .select(machineSelection)
        .from(relayMachines)
        .where(eq(relayMachines.machineId, input.machineId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachinePersistenceError({
                operation: "load-machine",
                machineId: input.machineId,
                cause,
              }),
          ),
        );
      return rows[0] ?? null;
    }),

    listForOrganization: Effect.fn("relay.machines.list_for_organization")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      return yield* db
        .select(machineSelection)
        .from(relayMachines)
        .where(eq(relayMachines.organizationId, input.organizationId))
        .orderBy(relayMachines.createdAt)
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachinePersistenceError({
                operation: "list-machines",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
    }),

    countActiveForOrganization: Effect.fn("relay.machines.count_active_for_organization")(
      function* (input) {
        const rows = yield* db
          .select({ total: drizzleSql<number>`count(*)::int` })
          .from(relayMachines)
          .where(
            and(
              eq(relayMachines.organizationId, input.organizationId),
              isNull(relayMachines.deprovisionedAt),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new MachinePersistenceError({
                  operation: "count-machines",
                  organizationId: input.organizationId,
                  cause,
                }),
            ),
          );
        return rows[0]?.total ?? 0;
      },
    ),

    getBySeedHash: Effect.fn("relay.machines.get_by_seed_hash")(function* (input) {
      const rows = yield* db
        .select(machineSelection)
        .from(relayMachines)
        .where(eq(relayMachines.seedHash, input.seedHash))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachinePersistenceError({
                operation: "load-by-seed",
                cause,
              }),
          ),
        );
      return rows[0] ?? null;
    }),

    getActiveByEnvironmentId: Effect.fn("relay.machines.get_active_by_environment_id")(
      function* (input) {
        const rows = yield* db
          .select(machineSelection)
          .from(relayMachines)
          .where(
            and(
              eq(relayMachines.environmentId, input.environmentId),
              isNull(relayMachines.deprovisionedAt),
            ),
          )
          .limit(1)
          .pipe(
            Effect.mapError(
              (cause) =>
                new MachinePersistenceError({
                  operation: "load-by-environment",
                  cause,
                }),
            ),
          );
        return rows[0] ?? null;
      },
    ),

    recordComputeRef: Effect.fn("relay.machines.record_compute_ref")(function* (input) {
      yield* db
        .update(relayMachines)
        .set({
          computeRef: input.computeRef,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(eq(relayMachines.machineId, input.machineId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachinePersistenceError({
                operation: "record-compute-ref",
                machineId: input.machineId,
                cause,
              }),
          ),
        );
    }),

    claimEnrollment: Effect.fn("relay.machines.claim_enrollment")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.machine_id": input.machineId,
        "relay.environment_id": input.environmentId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayMachines)
        .set({
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          endpointHttpBaseUrl: input.endpoint.httpBaseUrl,
          endpointWsBaseUrl: input.endpoint.wsBaseUrl,
          endpointProviderKind: input.endpoint.providerKind,
          enrolledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(relayMachines.machineId, input.machineId),
            isNull(relayMachines.enrolledAt),
            isNull(relayMachines.deprovisionedAt),
          ),
        )
        .returning({ machineId: relayMachines.machineId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachinePersistenceError({
                operation: "claim-enrollment",
                machineId: input.machineId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),

    deprovision: Effect.fn("relay.machines.deprovision")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.machine_id": input.machineId });
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayMachines)
        .set({ deprovisionedAt: now, updatedAt: now })
        .where(
          and(eq(relayMachines.machineId, input.machineId), isNull(relayMachines.deprovisionedAt)),
        )
        .returning({ machineId: relayMachines.machineId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachinePersistenceError({
                operation: "deprovision-machine",
                machineId: input.machineId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),

    remove: Effect.fn("relay.machines.remove")(function* (input) {
      yield* db
        .delete(relayMachines)
        .where(eq(relayMachines.machineId, input.machineId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachinePersistenceError({
                operation: "remove-machine",
                machineId: input.machineId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(Machines, make);
