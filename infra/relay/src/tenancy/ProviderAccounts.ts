import type {
  RelayProviderAccountKind,
  RelayProviderAccountProvider,
} from "@t3tools/contracts/relay";
import { and, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayOrganizationProviderAccounts } from "../persistence/schema.ts";

export interface ProviderAccountRecord {
  readonly organizationId: string;
  readonly provider: RelayProviderAccountProvider;
  readonly kind: RelayProviderAccountKind;
  readonly label: string;
  /** Sealed by `RelaySecretBox`; never the payload itself. */
  readonly payloadSealed: string;
  readonly version: string;
  readonly createdByUserId: string;
  readonly updatedByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ProviderAccountPersistenceError extends Schema.TaggedErrorClass<ProviderAccountPersistenceError>()(
  "ProviderAccountPersistenceError",
  {
    operation: Schema.Literals(["list", "save", "delete"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider account record '${this.operation}' failed`;
  }
}

const columns = {
  organizationId: relayOrganizationProviderAccounts.organizationId,
  provider: relayOrganizationProviderAccounts.provider,
  kind: relayOrganizationProviderAccounts.kind,
  label: relayOrganizationProviderAccounts.label,
  payloadSealed: relayOrganizationProviderAccounts.payloadSealed,
  version: relayOrganizationProviderAccounts.version,
  createdByUserId: relayOrganizationProviderAccounts.createdByUserId,
  updatedByUserId: relayOrganizationProviderAccounts.updatedByUserId,
  createdAt: relayOrganizationProviderAccounts.createdAt,
  updatedAt: relayOrganizationProviderAccounts.updatedAt,
};

// The columns are plain varchar; the API layer only ever writes values decoded
// through the contract literals, so narrowing on the way out is sound.
function toRecord(row: { readonly [K in keyof typeof columns]: string }): ProviderAccountRecord {
  return {
    ...row,
    provider: row.provider as RelayProviderAccountProvider,
    kind: row.kind as RelayProviderAccountKind,
  };
}

/** An organization's provider accounts: one row per provider, replaced on every save. */
export class ProviderAccounts extends Context.Service<
  ProviderAccounts,
  {
    readonly listForOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<ReadonlyArray<ProviderAccountRecord>, ProviderAccountPersistenceError>;
    readonly save: (input: {
      readonly organizationId: string;
      readonly provider: RelayProviderAccountProvider;
      readonly kind: RelayProviderAccountKind;
      readonly label: string;
      readonly payloadSealed: string;
      readonly userId: string;
    }) => Effect.Effect<ProviderAccountRecord, ProviderAccountPersistenceError>;
    readonly delete: (input: {
      readonly organizationId: string;
      readonly provider: RelayProviderAccountProvider;
    }) => Effect.Effect<boolean, ProviderAccountPersistenceError>;
  }
>()("t3code-relay/tenancy/ProviderAccounts") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;

  return ProviderAccounts.of({
    listForOrganization: Effect.fn("relay.provider_accounts.list")(function* (input) {
      const rows = yield* db
        .select(columns)
        .from(relayOrganizationProviderAccounts)
        .where(eq(relayOrganizationProviderAccounts.organizationId, input.organizationId))
        .orderBy(relayOrganizationProviderAccounts.provider)
        .pipe(
          Effect.mapError(
            (cause) => new ProviderAccountPersistenceError({ operation: "list", cause }),
          ),
        );
      return rows.map(toRecord);
    }),

    save: Effect.fn("relay.provider_accounts.save")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const version = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) => new ProviderAccountPersistenceError({ operation: "save", cause }),
        ),
      );
      const rows = yield* db
        .insert(relayOrganizationProviderAccounts)
        .values({
          organizationId: input.organizationId,
          provider: input.provider,
          kind: input.kind,
          label: input.label,
          payloadSealed: input.payloadSealed,
          version,
          createdByUserId: input.userId,
          updatedByUserId: input.userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            relayOrganizationProviderAccounts.organizationId,
            relayOrganizationProviderAccounts.provider,
          ],
          set: {
            kind: input.kind,
            label: input.label,
            payloadSealed: input.payloadSealed,
            version,
            updatedByUserId: input.userId,
            updatedAt: now,
          },
        })
        .returning(columns)
        .pipe(
          Effect.mapError(
            (cause) => new ProviderAccountPersistenceError({ operation: "save", cause }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return yield* new ProviderAccountPersistenceError({
          operation: "save",
          cause: "save returned no row",
        });
      }
      return toRecord(row);
    }),

    delete: Effect.fn("relay.provider_accounts.delete")(function* (input) {
      const rows = yield* db
        .delete(relayOrganizationProviderAccounts)
        .where(
          and(
            eq(relayOrganizationProviderAccounts.organizationId, input.organizationId),
            eq(relayOrganizationProviderAccounts.provider, input.provider),
          ),
        )
        .returning({ provider: relayOrganizationProviderAccounts.provider })
        .pipe(
          Effect.mapError(
            (cause) => new ProviderAccountPersistenceError({ operation: "delete", cause }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(ProviderAccounts, make);
