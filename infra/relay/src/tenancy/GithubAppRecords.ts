import { desc } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayGithubApps } from "../persistence/schema.ts";

export interface GithubAppRecord {
  readonly appId: string;
  readonly appSlug: string;
  /** Sealed by `RelaySecretBox`; never the PEM itself. */
  readonly privateKeySealed: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export class GithubAppPersistenceError extends Schema.TaggedErrorClass<GithubAppPersistenceError>()(
  "GithubAppPersistenceError",
  {
    operation: Schema.Literals(["load", "save"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub App record '${this.operation}' failed`;
  }
}

const columns = {
  appId: relayGithubApps.appId,
  appSlug: relayGithubApps.appSlug,
  privateKeySealed: relayGithubApps.privateKeySealed,
  createdByUserId: relayGithubApps.createdByUserId,
  createdAt: relayGithubApps.createdAt,
};

/** The relay's GitHub App as created from Organization settings; at most one. */
export class GithubAppRecords extends Context.Service<
  GithubAppRecords,
  {
    readonly get: Effect.Effect<GithubAppRecord | null, GithubAppPersistenceError>;
    readonly save: (input: {
      readonly appId: string;
      readonly appSlug: string;
      readonly privateKeySealed: string;
      readonly createdByUserId: string;
    }) => Effect.Effect<GithubAppRecord, GithubAppPersistenceError>;
  }
>()("t3code-relay/tenancy/GithubAppRecords") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return GithubAppRecords.of({
    get: db
      .select(columns)
      .from(relayGithubApps)
      .orderBy(desc(relayGithubApps.createdAt))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError((cause) => new GithubAppPersistenceError({ operation: "load", cause })),
      ),

    save: Effect.fn("relay.github_app_records.save")(function* (input) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .insert(relayGithubApps)
        .values({ ...input, createdAt })
        .returning(columns)
        .pipe(
          Effect.mapError((cause) => new GithubAppPersistenceError({ operation: "save", cause })),
        );
      const row = rows[0];
      if (!row) {
        return yield* new GithubAppPersistenceError({
          operation: "save",
          cause: "save returned no row",
        });
      }
      return row;
    }),
  });
});

export const layer = Layer.effect(GithubAppRecords, make);
