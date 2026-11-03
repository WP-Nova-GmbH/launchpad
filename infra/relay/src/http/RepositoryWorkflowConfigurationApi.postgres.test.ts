import { describe, expect, layer } from "@effect/vitest";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import {
  RelayApi,
  RelayClientAuth,
  RelayClientPrincipal,
  type RelayUpdateRepositoryWorkflowConfiguration,
} from "@t3tools/contracts/relay";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import * as Statement from "effect/unstable/sql/Statement";
import { RelayConfiguration } from "../Config.ts";
import * as SecretBox from "../auth/SecretBox.ts";
import { RelayDb, RelayTransactions } from "../db.ts";
import { readWorkflowConfigurationForFreeze } from "../jobs/RepositoryWorkflowConfiguration.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import { GithubInstallations } from "../tenancy/GithubInstallations.ts";
import * as Organizations from "../tenancy/Organizations.ts";
import * as Repositories from "../tenancy/Repositories.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { configLayer } from "../workflowSources/test-fixture.ts";
import { relayCors, relayNotFoundRoute, traceRelayHttpRequestWith } from "./Api.ts";
import {
  getRepositoryWorkflowConfiguration,
  updateRepositoryWorkflowConfiguration,
} from "./RepositoryWorkflowConfigurationApi.ts";
import { repositoriesApi } from "./TenancyApi.ts";

const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;
const migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!databaseUrl || !/^\/launchpad_vm_test_[a-z0-9_]+$/u.test(new URL(databaseUrl).pathname))
      return yield* Effect.die("Tests require a dedicated launchpad_vm_test_* database");
    yield* migrate(yield* PgDrizzle.makeWithDefaults(), {
      migrationsFolder: new URL("../../migrations/postgres/", import.meta.url).pathname,
      migrationsTable: "relay_migrations",
    });
  }),
).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl ?? ""), maxConnections: 5 })),
);
const services = Layer.mergeAll(
  Organizations.layer,
  Repositories.layer,
  RelayTransactions.layer,
).pipe(
  Layer.provideMerge(
    Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(Layer.provide(migrated)),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      NodeCrypto.layer,
      SecretBox.layer.pipe(Layer.provide(configLayer)),
      configLayer,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected upstream call")),
      ),
      Layer.mock(UserDirectory, {}),
      Layer.mock(GithubApp, {}),
      Layer.mock(GithubInstallations, {}),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const fixture = Effect.fnUntraced(function* () {
  const crypto = yield* Crypto.Crypto;
  const organizationId = yield* crypto.randomUUIDv4;
  const repositoryId = yield* crypto.randomUUIDv4;
  const admin = yield* crypto.randomUUIDv4;
  const maintainer = yield* crypto.randomUUIDv4;
  const developer = yield* crypto.randomUUIDv4;
  const outsider = yield* crypto.randomUUIDv4;
  const organizations = yield* Organizations.Organizations;
  const repositories = yield* Repositories.Repositories;
  yield* organizations.ensureForUser({ organizationId, userId: admin });
  yield* organizations.addMember({ organizationId, userId: maintainer, role: "member" });
  yield* organizations.addMember({ organizationId, userId: developer, role: "member" });
  yield* organizations.ensureForUser({
    organizationId: yield* crypto.randomUUIDv4,
    userId: outsider,
  });
  yield* repositories.register({
    organizationId,
    repositoryId,
    name: "Workflow repository",
    canonicalKey: "github.com/launchpad/" + repositoryId,
    createdByUserId: maintainer,
  });
  yield* repositories.grantAccess({
    organizationId,
    repositoryId,
    userId: developer,
    role: "developer",
  });
  return { organizationId, repositoryId, admin, maintainer, developer, outsider };
});

const Json = Schema.fromJsonString(Schema.Unknown);
const encode = Schema.encodeSync(Json);
const decode = Schema.decodeUnknownSync(Json);
const request = (repositoryId: string, userId: string, body?: string) =>
  HttpServerRequest.fromWeb(
    new Request("https://relay.test/v1/repositories/" + repositoryId + "/workflow-environment", {
      headers: { authorization: "Bearer " + userId, "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "PATCH", body }),
    }),
  );
const buildHttp = Effect.fnUntraced(function* () {
  const deps = Layer.succeedContext(
    yield* Effect.context<
      | RelayDb
      | RelayTransactions
      | SecretBox.RelaySecretBox
      | Organizations.Organizations
      | Repositories.Repositories
      | UserDirectory
      | GithubApp
      | GithubInstallations
      | Crypto.Crypto
      | RelayConfiguration
      | HttpClient.HttpClient
    >(),
  );
  const api = HttpApi.make("RelayApi").add(RelayApi.groups.repositories);
  const routes = HttpApiBuilder.layer(api).pipe(
    Layer.provide(
      repositoriesApi.pipe(
        HttpRouter.provideRequest(deps),
        Layer.provide(deps),
        Layer.provideMerge(
          Layer.succeed(RelayClientAuth, {
            clientBearer: (effect, { credential }) =>
              Effect.provideService(effect, RelayClientPrincipal, {
                userId: Redacted.value(credential).trimStart(),
                token: "test",
              }),
          }),
        ),
      ),
    ),
    Layer.provide(HttpServer.layerServices),
  );
  return yield* HttpRouter.toHttpEffect(Layer.mergeAll(routes, relayCors, relayNotFoundRoute));
});

const call = Effect.fnUntraced(function* (
  http: Effect.Success<ReturnType<typeof buildHttp>>,
  repositoryId: string,
  userId: string,
  update?: RelayUpdateRepositoryWorkflowConfiguration,
) {
  const response = yield* http.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      request(repositoryId, userId, update && encode(update)),
    ),
  );
  return {
    status: response.status,
    body: decode(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())),
  };
});

describe.skipIf(!databaseUrl)("repository workflow environment HTTP (Postgres)", () => {
  layer(services)((it) => {
    it.effect(
      "returns public variables and secret names, and scopes both methods to current maintainers",
      () =>
        Effect.gen(function* () {
          const scope = yield* fixture();
          const http = yield* buildHttp();
          const preflight = yield* http.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(
                  "https://relay.test/v1/repositories/" +
                    scope.repositoryId +
                    "/workflow-environment",
                  {
                    method: "OPTIONS",
                    headers: {
                      origin: "https://launchpad.test",
                      "access-control-request-method": "PATCH",
                      "access-control-request-headers": "authorization,content-type",
                    },
                  },
                ),
              ),
            ),
          );
          expect(preflight.status).toBe(204);
          expect(preflight.headers["access-control-allow-methods"]?.split(",")).toContain("PATCH");
          const {
            repositoryId: repo,
            organizationId,
            admin,
            maintainer,
            developer,
            outsider,
          } = scope;
          const sql = (yield* RelayDb).$client;
          const box = yield* SecretBox.RelaySecretBox;
          const value = "first-secret-value\n\t";
          expect(yield* call(http, repo, admin)).toEqual({
            status: 200,
            body: { organizationId, repositoryId: repo, revision: 0, entries: [] },
          });
          expect((yield* call(http, repo, developer)).status).toBe(403);
          expect((yield* call(http, repo, outsider)).status).toBe(404);
          const variable = { kind: "setVariable", name: "APP_MODE", value: " value\n\t " } as const;
          const secret = { kind: "setSecret", name: "APP_TOKEN", value } as const;
          expect(
            (yield* call(http, repo, developer, { expectedRevision: 0, mutation: variable }))
              .status,
          ).toBe(403);
          expect(
            (yield* call(http, repo, outsider, { expectedRevision: 0, mutation: variable })).status,
          ).toBe(404);
          expect(
            (yield* call(http, repo, maintainer, { expectedRevision: 0, mutation: variable }))
              .status,
          ).toBe(200);
          expect(
            yield* call(http, repo, maintainer, { expectedRevision: 1, mutation: secret }),
          ).toEqual({
            status: 200,
            body: {
              organizationId,
              repositoryId: repo,
              revision: 2,
              entries: [
                { kind: "variable", name: "APP_MODE", value: variable.value },
                { kind: "secret", name: "APP_TOKEN" },
              ],
            },
          });
          expect((yield* call(http, repo, admin)).body).toMatchObject({
            entries: [
              { name: "APP_MODE", value: variable.value },
              { kind: "secret", name: "APP_TOKEN" },
            ],
          });
          const [stored] = yield* sql<{ entries: string }>`
          SELECT entries::text FROM relay_repository_workflow_configurations WHERE repository_id=${repo}
        `;
          expect(stored!.entries).not.toContain("first-secret-value");
          expect(yield* readWorkflowConfigurationForFreeze(sql, box, scope)).toEqual({
            revision: 2,
            values: [
              { kind: "variable", name: "APP_MODE", value: variable.value },
              { kind: "secret", name: "APP_TOKEN", value },
            ],
            hasSecrets: true,
          });
          expect(
            (yield* call(http, repo, admin, {
              expectedRevision: 2,
              mutation: { ...secret, value: "new-secret-value" },
            })).status,
          ).toBe(200);
          expect(
            (yield* readWorkflowConfigurationForFreeze(sql, box, scope)).values[1]?.value,
          ).toBe("new-secret-value");
          for (const [revision, name] of [
            [3, "APP_TOKEN"],
            [4, "APP_MODE"],
          ] as const)
            expect(
              (yield* call(http, repo, maintainer, {
                expectedRevision: revision,
                mutation: { kind: "delete", name },
              })).status,
            ).toBe(200);
          expect((yield* call(http, repo, admin)).body).toMatchObject({ revision: 5, entries: [] });
          expect(
            (yield* call(http, repo, admin, { expectedRevision: 0, mutation: variable })).status,
          ).toBe(409);
          yield* sql`DELETE FROM relay_repositories WHERE repository_id=${repo}`;
          expect(
            yield* sql`SELECT repository_id FROM relay_repository_workflow_configurations WHERE repository_id=${repo}`,
          ).toHaveLength(0);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "serializes first saves and rejects reserved names, kind collisions and UTF-8 bounds",
      () =>
        Effect.gen(function* () {
          const { repositoryId: repo, maintainer } = yield* fixture();
          const http = yield* buildHttp();
          const variable = { kind: "setVariable", name: "APP_MODE", value: "a" } as const;
          const replies = yield* Effect.forEach(
            [variable, { ...variable, value: "b" }],
            (mutation) => call(http, repo, maintainer, { expectedRevision: 0, mutation }),
            { concurrency: 2 },
          );
          expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
          for (const mutation of [
            { ...variable, name: "ld_PRELOAD" },
            { ...variable, name: "T3CODE_HOME" },
            { ...variable, name: "OPENAI_API_KEY" },
            { ...variable, value: "a\0b" },
            { ...variable, value: "\uD800" },
            { ...variable, value: "🧪".repeat(1025) },
            { ...variable, kind: "setSecret" as const },
            { kind: "setSecret" as const, name: "TOKEN", value: "" },
          ]) {
            const reply = yield* call(http, repo, maintainer, { expectedRevision: 1, mutation });
            expect(reply.status).toBe(422);
          }
          expect((yield* call(http, repo, maintainer)).body).toMatchObject({ revision: 1 });
        }).pipe(Effect.scoped),
    );

    it.effect("rechecks write authority after the initial membership read", () =>
      Effect.gen(function* () {
        const { organizationId, repositoryId, admin, maintainer } = yield* fixture();
        const organizations = yield* Organizations.Organizations;
        const loaded = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const payload = {
          expectedRevision: 0,
          mutation: { kind: "setSecret", name: "TOKEN", value: "unused" },
        };
        const saving = yield* updateRepositoryWorkflowConfiguration(
          repositoryId,
          request(repositoryId, admin, encode(payload)),
        ).pipe(
          Effect.provideService(RelayClientPrincipal, { userId: admin, token: "test" }),
          Effect.provideService(Organizations.Organizations, {
            ...organizations,
            getMembershipForUser: (input) =>
              organizations.getMembershipForUser(input).pipe(
                Effect.tap(() => Deferred.succeed(loaded, undefined)),
                Effect.tap(() => Deferred.await(proceed)),
              ),
          }),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(loaded);
        const sql = (yield* RelayDb).$client;
        yield* sql`UPDATE relay_organization_members SET role='member' WHERE organization_id=${organizationId} AND user_id=${admin}`;
        yield* Deferred.succeed(proceed, undefined);
        expect(yield* Fiber.join(saving)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "RelayTenancyForbiddenError", reason: "no_repository_access" },
        });
        const http = yield* buildHttp();
        expect((yield* call(http, repositoryId, maintainer)).body).toMatchObject({ revision: 0 });
      }).pipe(Effect.scoped),
    );

    it.effect("denies a read when authority changes before loading the configuration", () =>
      Effect.gen(function* () {
        const { organizationId, repositoryId, admin, maintainer } = yield* fixture();
        const organizations = yield* Organizations.Organizations;
        const loaded = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const reading = yield* getRepositoryWorkflowConfiguration(repositoryId).pipe(
          Effect.provideService(RelayClientPrincipal, { userId: admin, token: "test" }),
          Effect.provideService(Organizations.Organizations, {
            ...organizations,
            getMembershipForUser: (input) =>
              organizations.getMembershipForUser(input).pipe(
                Effect.tap(() => Deferred.succeed(loaded, undefined)),
                Effect.tap(() => Deferred.await(proceed)),
              ),
          }),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(loaded);
        const sql = (yield* RelayDb).$client;
        yield* sql`UPDATE relay_organization_members SET role='member' WHERE organization_id=${organizationId} AND user_id=${admin}`;
        const http = yield* buildHttp();
        expect(
          (yield* call(http, repositoryId, maintainer, {
            expectedRevision: 0,
            mutation: { kind: "setVariable", name: "APP_MODE", value: "saved after demotion" },
          })).status,
        ).toBe(200);
        yield* Deferred.succeed(proceed, undefined);
        expect(yield* Fiber.join(reading)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "RelayTenancyForbiddenError", reason: "no_repository_access" },
        });
      }).pipe(Effect.scoped),
    );

    it.effect("holds current read authority until the configuration is loaded", () =>
      Effect.gen(function* () {
        const { organizationId, repositoryId, maintainer } = yield* fixture();
        const readyToRead = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const reading = yield* getRepositoryWorkflowConfiguration(repositoryId).pipe(
          Effect.provideService(RelayClientPrincipal, { userId: maintainer, token: "test" }),
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            statement.compile()[0].includes("FROM relay_repository_workflow_configurations")
              ? Deferred.succeed(readyToRead, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.as(statement),
                )
              : Effect.succeed(statement),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(readyToRead);
        const sql = (yield* RelayDb).$client;
        for (const probe of [
          sql`SELECT 1 FROM relay_organization_members
            WHERE organization_id=${organizationId} AND user_id=${maintainer} FOR UPDATE NOWAIT`,
          sql`SELECT 1 FROM relay_repository_access
            WHERE organization_id=${organizationId} AND repository_id=${repositoryId}
              AND user_id=${maintainer} FOR UPDATE NOWAIT`,
          sql`SELECT 1 FROM relay_repositories
            WHERE organization_id=${organizationId} AND repository_id=${repositoryId} FOR NO KEY UPDATE NOWAIT`,
        ]) {
          expect(yield* Effect.flip(probe)).toMatchObject({
            _tag: "SqlError",
            reason: { _tag: "LockTimeoutError" },
          });
        }
        yield* Deferred.succeed(proceed, undefined);
        expect(yield* Fiber.join(reading)).toMatchObject({
          repositoryId,
          revision: 0,
          entries: [],
        });
        const repositories = yield* Repositories.Repositories;
        expect(yield* repositories.revokeAccess({ repositoryId, userId: maintainer })).toBe(true);
        const http = yield* buildHttp();
        expect((yield* call(http, repositoryId, maintainer)).status).toBe(403);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "redacts malformed, oversized and failed secret writes from responses and diagnostics",
      () =>
        Effect.gen(function* () {
          const { repositoryId: repo, maintainer } = yield* fixture();
          const canary = "p02-private-diagnostics-canary";
          const sql = (yield* RelayDb).$client;
          yield* Effect.acquireRelease(
            sql`ALTER TABLE relay_repository_workflow_configurations
              ADD CONSTRAINT p02_test_force_storage_failure
              CHECK (NOT entries @> '[{"name":"FORCE_STORAGE_FAILURE"}]'::jsonb) NOT VALID`,
            () =>
              sql`ALTER TABLE relay_repository_workflow_configurations
              DROP CONSTRAINT p02_test_force_storage_failure`.pipe(Effect.orDie),
          );
          const box = yield* SecretBox.RelaySecretBox;
          const failingBox = {
            ...box,
            seal: (plaintext: string) =>
              plaintext.includes("FORCE_STORAGE_FAILURE")
                ? box.seal(plaintext)
                : Effect.fail(
                    new SecretBox.SecretBoxError({ operation: "seal", cause: new Error(canary) }),
                  ),
          };
          const http = yield* buildHttp().pipe(
            Effect.provideService(SecretBox.RelaySecretBox, failingBox),
          );
          const spans: Array<Tracer.NativeSpan> = [];
          const tracer = Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              spans.push(span);
              return span;
            },
          });
          const messages: Array<string> = [];
          const logger = Logger.map(Logger.formatJson, (message) => messages.push(message));
          for (const [body, status] of [
            ['{"value":"' + canary, 422],
            [
              encode({
                expectedRevision: 0,
                mutation: { kind: "setSecret", name: "TOKEN", value: { invalid: canary } },
              }),
              422,
            ],
            [
              encode({
                expectedRevision: 0,
                mutation: { kind: "setSecret", name: "TOKEN", value: canary.repeat(1000) },
              }),
              422,
            ],
            [
              encode({
                expectedRevision: 0,
                mutation: { kind: "setSecret", name: "TOKEN", value: canary },
              }),
              500,
            ],
            [
              encode({
                expectedRevision: 0,
                mutation: { kind: "setSecret", name: "FORCE_STORAGE_FAILURE", value: canary },
              }),
              500,
            ],
          ] as const) {
            const response = yield* traceRelayHttpRequestWith(
              http,
              Layer.succeed(Tracer.Tracer, tracer),
            ).pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                request(repo, maintainer, body),
              ),
              Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            );
            expect(response.status).toBe(status);
            expect(
              yield* Effect.promise(() => HttpServerResponse.toWeb(response).text()),
            ).not.toContain(canary);
          }
          expect(spans.map((span) => span.name)).toContain(
            "relay.api.repository_workflow_configuration.update",
          );
          expect(
            NodeUtil.inspect(
              spans.map((span) => ({
                name: span.name,
                attributes: Object.fromEntries(span.attributes),
                events: span.events,
              })),
              { depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false },
            ),
          ).not.toContain(canary);
          expect(messages.join("\n")).not.toContain(canary);
          expect((yield* call(http, repo, maintainer)).body).toMatchObject({ revision: 0 });
        }).pipe(Effect.scoped),
    );
  });
});
