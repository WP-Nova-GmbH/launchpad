import { RelayConfiguration } from "../Config.ts";
import * as SecretBox from "../auth/SecretBox.ts";
import * as Crypto from "effect/Crypto";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { RelayDb, RelayTransactions } from "../db.ts";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Store from "./Store.ts";

export const databaseUrl = process.env.WORKFLOW_SOURCES_TEST_DATABASE_URL;
export const config = RelayConfiguration.of({
  relayIssuer: "https://relay.test",
  apns: null,
  clerkSecretKey: Redacted.make("clerk"),
  clerkPublishableKey: "public",
  clerkJwtAudience: "relay",
  apnsDeliveryJobSigningSecret: Redacted.make("push"),
  cloudMintPrivateKey: Redacted.make("workflow-source-test-key"),
  cloudMintPublicKey: "public",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
  linearWorkflow: { clientId: "native-app" },
});
export const configLayer = Layer.succeed(RelayConfiguration, config);
export const tokenReply = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 86400,
  token_type: "Bearer",
  scope: "read",
};
export const identityReply = {
  data: {
    organization: { id: "workspace", name: "Workspace" },
    viewer: { id: "linear-owner", name: "Linear Owner" },
  },
};
export const transport = (reply: (req: HttpClientRequest) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) => Effect.succeed(HttpClientResponse.fromWeb(req, reply(req)))),
  );
type HttpClientRequest = Parameters<Parameters<typeof HttpClient.make>[0]>[0];
export const defaultTransport = transport((req) =>
  Response.json(req.url.endsWith("/oauth/token") ? tokenReply : identityReply),
);
export const directory = Layer.mock(UserDirectory, { lookup: () => Effect.succeed(new Map()) });
export const migrationPath = new URL(
  "../../migrations/postgres/20261015122012_workflow_sources/migration.sql",
  import.meta.url,
).pathname;
/** Creates and drops only a fresh database owned by this test, never tables in the supplied database. */
export const withDatabase = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const admin = yield* PgClient.PgClient;
    const name =
      "wf_sources_" +
      (yield* Crypto.Crypto.pipe(Effect.flatMap((c) => c.randomUUIDv4))).replaceAll("-", "");
    const url = new URL(databaseUrl!);
    url.pathname = "/" + name;
    const database = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.toString()) })),
    );
    const dependencies = Layer.mergeAll(
      database,
      NodeCrypto.layer,
      NodeFileSystem.layer,
      configLayer,
      directory,
      defaultTransport,
      SecretBox.layer.pipe(Layer.provide(configLayer)),
    );
    return yield* Effect.acquireUseRelease(
      admin.unsafe(`CREATE DATABASE "${name}"`),
      () =>
        Effect.gen(function* () {
          const sql = (yield* RelayDb).$client;
          for (const statement of `CREATE TABLE relay_organizations(organization_id text PRIMARY KEY,name text NOT NULL,created_at text DEFAULT '2026',updated_at text DEFAULT '2026');
CREATE TABLE relay_organization_members(organization_id text NOT NULL,user_id text NOT NULL UNIQUE,role text NOT NULL,created_at text DEFAULT '2026',updated_at text DEFAULT '2026',PRIMARY KEY(organization_id,user_id));
CREATE TABLE relay_repositories(repository_id text PRIMARY KEY,organization_id text NOT NULL,name text NOT NULL,created_at text DEFAULT '2026',updated_at text DEFAULT '2026');
CREATE TABLE relay_repository_access(repository_id text NOT NULL,user_id text NOT NULL,organization_id text NOT NULL,role text NOT NULL,created_at text DEFAULT '2026',updated_at text DEFAULT '2026',PRIMARY KEY(repository_id,user_id));
CREATE TABLE relay_repository_aliases(canonical_key text PRIMARY KEY,repository_id text NOT NULL,organization_id text NOT NULL,created_at text DEFAULT '2026');`.split(
            ";",
          ))
            if (statement.trim()) yield* sql.unsafe(statement);
          const fs = yield* FileSystem.FileSystem;
          for (const file of [
            ...["20260819153249_machines", "20260824143719_organization_project_catalog"].map(
              (name) =>
                new URL(`../../migrations/postgres/${name}/migration.sql`, import.meta.url)
                  .pathname,
            ),
            new URL(
              "../../migrations/postgres/20260928113352_repository_policy/migration.sql",
              import.meta.url,
            ).pathname,
            migrationPath,
            ...[
              "20261008114100_repository_workflows",
              "20261015110011_workflow_job_pages",
              "20261015151148_workflow_origin",
              "20261016074602_workflow_events",
            ].map(
              (name) =>
                new URL(`../../migrations/postgres/${name}/migration.sql`, import.meta.url)
                  .pathname,
            ),
          ]) {
            const migration = yield* fs.readFileString(file);
            for (const statement of migration.split("--> statement-breakpoint"))
              if (statement.trim()) yield* sql.unsafe(statement);
          }
          yield* sql`INSERT INTO relay_organizations(organization_id,name) VALUES ('org','Organization'),('other-org','Other')`;
          yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role) VALUES ('org','owner','member'),('org','maintainer','member'),('org','reader','member'),('org','admin','admin'),('other-org','outsider','admin')`;
          yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name) VALUES ('repo','org','Repository'),('repo-2','org','Second'),('foreign','other-org','Foreign')`;
          yield* sql`INSERT INTO relay_repository_access(repository_id,user_id,organization_id,role) VALUES ('repo','owner','org','maintainer'),('repo','maintainer','org','maintainer'),('repo','reader','org','developer'),('repo-2','owner','org','maintainer')`;
          return yield* program.pipe(Effect.provide(RelayTransactions.layer));
        }).pipe(Effect.provide(dependencies), Effect.scoped),
      () => admin.unsafe(`DROP DATABASE "${name}"`).pipe(Effect.orDie),
    );
  }).pipe(
    Effect.provide([PgClient.layer({ url: Redacted.make(databaseUrl ?? "") }), NodeCrypto.layer]),
    Effect.scoped,
  );
export const createConnection = Effect.fn("workflowSources.test.createConnection")(function* (
  id = "connection",
  owner = "owner",
  expired = false,
  workspace = "workspace",
) {
  const box = yield* RelaySecretBox;
  const sealed = yield* box.seal(
    Store.json({
      accessToken: "old-access-" + owner,
      refreshToken: "old-refresh-" + owner,
      expiresAt: (yield* Store.now) + (expired ? -1 : 86_400_000),
    }),
  );
  const sql = (yield* RelayDb).$client;
  yield* sql`INSERT INTO relay_workflow_connections(connection_id,owner_user_id,application_id,workspace_id,workspace_name,viewer_name,status,activated_at,payload_sealed,health) VALUES (${id},${owner},'native-app',${workspace},'Workspace','Linear Owner','connected',${Store.iso(yield* Store.now)},${sealed},${Store.json(Store.healthy)}::jsonb)`;
  return (yield* Store.connection(id))!;
});
