import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type WorkflowOrigin } from "@t3tools/contracts";
import { RelayCloudDispatchJobRequest } from "@t3tools/contracts/relay";
import {
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Redacted,
  Scope,
  Exit,
} from "effect";
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/unstable/http";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import {
  EnvironmentConnector,
  layer as connectorLayer,
} from "../environments/EnvironmentConnector.ts";
import { EnvironmentLinks } from "../environments/EnvironmentLinks.ts";
import { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";
import { Machines, type MachineRecord } from "../machines/Machines.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import { Repositories } from "../tenancy/Repositories.ts";
import { RepositoryPolicyControl } from "../tenancy/RepositoryPolicies.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";
import { Workflows, make as makeWorkflows } from "./Workflows.ts";
import { refreshWorkflowJob } from "./WorkflowDispatcher.ts";
import { cloudDispatchJobHandler } from "../../../../apps/server/src/cloud/http.ts";
import {
  CLOUD_MACHINE_IDENTITY,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  encodeCloudMachineIdentityJson,
} from "../../../../apps/server/src/cloud/config.ts";
import {
  ServerSecretStore,
  SecretStorePersistError,
} from "../../../../apps/server/src/auth/ServerSecretStore.ts";
import {
  make as makeAccess,
  RepositoryAccess,
} from "../../../../apps/server/src/auth/RepositoryAccess.ts";
import { ProjectionProjectRepository } from "../../../../apps/server/src/persistence/Services/ProjectionProjects.ts";
import { ProjectionSnapshotQuery } from "../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../../../../apps/server/src/project/RepositoryIdentityResolver.ts";
import { WorkflowActions } from "../../../../apps/server/src/jobs/WorkflowActions.ts";
import { harness as publishingHarness } from "../../../../apps/server/src/jobs/WorkflowActions.test-fixture.ts";
import { WorkflowRunStore } from "../../../../apps/server/src/jobs/WorkflowRunStore.ts";
import {
  harness,
  test,
  workflow,
  NOW,
} from "../../../../apps/server/src/jobs/RepositoryWorkflowRunner.test-fixture.ts";

const url = process.env.WORKFLOW_PAGES_TEST_DATABASE_URL;
const pgLayer = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url ?? ""), maxConnections: 1 })),
  Layer.provideMerge(NodeServices.layer),
);
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RelayCloudDispatchJobRequest));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const bytes = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!url)("automatic workflow production handoff", () => {
  it.effect(
    "dispatches signed automation, keeps the real reviewer, and recovers the same origin after restart",
    () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const fs = yield* FileSystem.FileSystem;
        for (const migration of [
          "20261008114100_repository_workflows",
          "20261015110011_workflow_job_pages",
          "20261015151148_workflow_origin",
        ]) {
          const source = yield* fs.readFileString(
            new URL(`../../migrations/postgres/${migration}/migration.sql`, import.meta.url)
              .pathname,
          );
          for (const statement of source.split("--> statement-breakpoint"))
            yield* sql.unsafe(statement.replace("CREATE TABLE", "CREATE TEMP TABLE"));
        }
        const store = yield* makeWorkflows;
        yield* test(
          Effect.gen(function* () {
            const h = yield* harness;
            const relayKeys = NodeCrypto.generateKeyPairSync("ed25519", {
              privateKeyEncoding: { format: "pem", type: "pkcs8" },
              publicKeyEncoding: { format: "pem", type: "spki" },
            });
            const environmentKeys = NodeCrypto.generateKeyPairSync("ed25519", {
              privateKeyEncoding: { format: "pem", type: "pkcs8" },
              publicKeyEncoding: { format: "pem", type: "spki" },
            });
            const relayIssuer = "https://relay.example.test";
            const values = new Map<string, Uint8Array>([
              [CLOUD_MINT_PUBLIC_KEY, bytes(relayKeys.publicKey)],
              [RELAY_ISSUER_SECRET, bytes(relayIssuer)],
              [
                CLOUD_MACHINE_IDENTITY,
                bytes(
                  yield* encodeCloudMachineIdentityJson({
                    machineId: "machine",
                    organizationId: "org-1",
                    role: "agent_executor",
                  }),
                ),
              ],
              ["cloud-link-ed25519-key-pair", bytes(encodeJson(environmentKeys))],
            ]);
            const secrets: ServerSecretStore["Service"] = {
              get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
              set: (name, value) =>
                Effect.sync(() => {
                  values.set(name, value);
                }),
              create: (name, value) =>
                Effect.suspend(() =>
                  values.has(name)
                    ? Effect.fail(
                        new SecretStorePersistError({ resource: name, cause: "AlreadyExists" }),
                      )
                    : Effect.sync(() => {
                        values.set(name, value);
                      }),
                ),
              remove: (name) =>
                Effect.sync(() => {
                  values.delete(name);
                }),
              getOrCreateRandom: () => Effect.die("unused"),
            };
            const query = yield* ProjectionSnapshotQuery.pipe(Effect.provide(h.mocks));
            const identities = yield* RepositoryIdentityResolver.pipe(Effect.provide(h.mocks));
            const identity = (yield* identities.resolve("/repo"))!;
            yield* Ref.update(h.projectState, (project) => ({
              ...project,
              repositoryIdentity: identity,
            }));
            const access = yield* makeAccess.pipe(
              Effect.provideService(ServerSecretStore, secrets),
              Effect.provideService(ProjectionSnapshotQuery, {
                ...query,
                getProjectShells: () =>
                  Ref.get(h.projectState).pipe(Effect.map((project) => [project])),
              }),
              Effect.provideService(RepositoryIdentityResolver, identities),
              Effect.provide(Layer.mock(ProjectionProjectRepository)({})),
            );
            yield* access.apply(
              {
                organizationId: "org-1",
                revision: 1,
                members: [{ userId: "bob", role: "member" }],
                repositories: [
                  {
                    repositoryId: "repo-1",
                    canonicalKeys: [identity.canonicalKey],
                    userIds: ["bob"],
                  },
                ],
              },
              true,
            );
            const publishing = yield* publishingHarness("none", {
              jobId: "job-1",
              base: "base-sha",
              tree: "prepared-tree",
              remoteName: "origin",
              access,
              onHead: (sha) => Ref.set(h.head, sha),
            });
            const publishedWorkflow = {
              ...workflow,
              definition: {
                ...workflow.definition,
                steps: [
                  ...workflow.definition.steps,
                  { id: "push", kind: "action" as const, title: "Push", action: "push" as const },
                  {
                    id: "pr",
                    kind: "action" as const,
                    title: "Open PR",
                    action: "open_pull_request" as const,
                  },
                ],
              },
            };
            const runnerScope = yield* Scope.make();
            const runnerRef = yield* Ref.make(
              yield* h.newRunner.pipe(
                Effect.provideService(WorkflowActions, publishing.actions),
                Effect.provideService(RepositoryAccess, access),
                Effect.provideService(Scope.Scope, runnerScope),
              ),
            );
            const crypto = yield* Crypto.Crypto;
            const transportScope = yield* Scope.Scope;
            const transport = HttpClient.make((request) =>
              Effect.gen(function* () {
                const envelope = decodeRequest(
                  request.body._tag === "Uint8Array"
                    ? new TextDecoder().decode(request.body.body)
                    : "{}",
                );
                const response = yield* cloudDispatchJobHandler(
                  {
                    secrets,
                    environment: {
                      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
                      getDescriptor: Effect.die("unused"),
                    },
                    jobRunner: { run: () => Effect.die("personal dispatch is forbidden") },
                    snapshotQuery: query,
                    repositoryIdentity: identities,
                    workflowRunner: yield* Ref.get(runnerRef),
                  },
                  envelope,
                  true,
                ).pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(new Request(request.url, { method: "POST" })),
                  ),
                );
                return HttpClientResponse.fromWeb(request, Response.json(response));
              }).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(Scope.Scope, transportScope),
                Effect.orDie,
              ),
            );
            const machine: MachineRecord = {
              machineId: "machine",
              organizationId: "org-1",
              role: "agent_executor",
              label: "Executor",
              computeKind: "docker",
              computeRef: null,
              seedExpiresAt: NOW,
              environmentId: "env-1",
              environmentPublicKey: environmentKeys.publicKey,
              endpointHttpBaseUrl: "http://127.0.0.1:4444",
              endpointWsBaseUrl: "ws://127.0.0.1:4444/ws",
              endpointProviderKind: "manual",
              createdByUserId: "removed-source-owner",
              enrolledAt: NOW,
              deprovisionedAt: null,
              createdAt: NOW,
            };
            const tenancy = Layer.mergeAll(
              Layer.mock(OrganizationProjectCatalog)({}),
              Layer.mock(Machines)({ getActiveByEnvironmentId: () => Effect.succeed(machine) }),
              Layer.mock(Organizations)({
                getMembershipForUser: ({ userId }) =>
                  Effect.succeed(
                    userId === "bob"
                      ? {
                          organization: { organizationId: "org-1", name: "Org", createdAt: NOW },
                          userId,
                          role: "member" as const,
                          joinedAt: NOW,
                        }
                      : null,
                  ),
              }),
              Layer.mock(Repositories)({
                getById: () =>
                  Effect.succeed({
                    repositoryId: "repo-1",
                    organizationId: "org-1",
                    name: "Repo",
                    canonicalKeys: [identity.canonicalKey],
                    createdAt: NOW,
                  }),
                getAccess: ({ userId }) =>
                  Effect.succeed(userId === "bob" ? ("maintainer" as const) : null),
              }),
            );
            const connector = yield* EnvironmentConnector.pipe(
              Effect.provide(
                connectorLayer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      tenancy,
                      Layer.mock(EnvironmentLinks)({}),
                      Layer.mock(ManagedEndpointAllocations)({ get: () => Effect.succeed(null) }),
                      Layer.mock(UserDirectory)({}),
                      Layer.succeed(RepositoryPolicyControl, { synchronize: () => Effect.void }),
                      Layer.succeed(HttpClient.HttpClient, transport),
                      Layer.succeed(RelayConfiguration, {
                        relayIssuer,
                        apns: null,
                        clerkSecretKey: Redacted.make("fixture"),
                        clerkPublishableKey: "fixture",
                        clerkJwtAudience: "fixture",
                        apnsDeliveryJobSigningSecret: Redacted.make("fixture"),
                        cloudMintPrivateKey: Redacted.make(relayKeys.privateKey),
                        cloudMintPublicKey: relayKeys.publicKey,
                        managedEndpointBaseDomain: undefined,
                        managedEndpointNamespace: undefined,
                        allowLocalMachineEndpoints: true,
                      }),
                    ),
                  ),
                ),
              ),
            );
            const origin: WorkflowOrigin = {
              kind: "automation",
              organizationId: "org-1",
              repositoryId: "repo-1",
              workflowId: workflow.workflowId,
              source: {
                provider: "linear",
                applicationId: "app",
                workspaceId: "workspace",
                connectionId: "connection",
                grantId: "grant",
              },
              occurrenceId: "event",
            };
            yield* store.createJob({
              jobId: "job-1",
              repositoryId: "repo-1",
              organizationId: "org-1",
              submitterUserId: null,
              repositoryCanonicalKey: identity.canonicalKey,
              status: "dispatching",
              revision: 0,
              leaseUntil: null,
              pendingControl: null,
              createdAt: NOW,
              checkedAt: NOW,
              record: {
                jobId: "job-1",
                origin,
                requiredProtocol: 8,
                repositoryId: "repo-1",
                workflowId: workflow.workflowId,
                environmentId: workflow.definition.environmentId,
                instruction: "Fixture issue",
                status: "dispatching",
                workflow: publishedWorkflow,
                progress: null,
                detail: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            });
            const refresh = refreshWorkflowJob("job-1").pipe(
              Effect.provideService(Workflows, store),
              Effect.provideService(EnvironmentConnector, connector),
              Effect.provide(tenancy),
            );
            expect((yield* refresh)?.progress?.status).toBe("preparing");
            expect((yield* h.starts)[0]).toMatchObject({
              workflowOrigin: { kind: "automation", workflowName: workflow.definition.name },
            });
            expect((yield* h.starts)[0]?.author).toBeUndefined();
            // Replayed Start uses the saved execution origin, never an absent human requester.
            expect((yield* refresh)?.requiredProtocol).toBe(8);
            yield* h.complete;
            const review = (yield* refresh)!.progress!;
            expect(review.status).toBe("awaiting_review");
            yield* Scope.close(runnerScope, Exit.void);
            yield* Ref.set(
              runnerRef,
              yield* h.newRunner.pipe(
                Effect.provideService(WorkflowActions, publishing.actions),
                Effect.provideService(RepositoryAccess, access),
              ),
            );
            const row = (yield* store.getJob("job-1"))!;
            yield* store.updateJob(row, row.record, {
              userId: "bob",
              response: {
                operation: "request_changes",
                checkpointId: review.checkpoint!.checkpointId,
                expectedRevision: review.revision,
                text: "Revise",
              },
            });
            yield* refresh;
            const saved = (yield* (yield* WorkflowRunStore).get("job-1"))!;
            expect(saved.origin).toEqual(origin);
            expect(saved.userId).toBeNull();
            expect(saved.sequence?.responses[0]?.userId).toBe("bob");
            expect((yield* h.starts).at(-1)?.author).toBeUndefined();
            expect((yield* store.getJob("job-1"))?.record.origin).toEqual(origin);
            yield* h.completeCurrent;
            const finalReview = (yield* refresh)!.progress!;
            const latest = (yield* store.getJob("job-1"))!;
            yield* store.updateJob(latest, latest.record, {
              userId: "bob",
              response: {
                operation: "approve",
                checkpointId: finalReview.checkpoint!.checkpointId,
                expectedRevision: finalReview.revision,
              },
            });
            yield* refresh;
            yield* h.awaitRun((run) => run.progress.status === "done");
            const done = yield* refresh;
            expect(done?.status).toBe("done");
            expect(publishing.counts()).toEqual({ commits: 1, pushes: 1 });
            expect(publishing.prCounts().creates).toBe(1);
            expect(done?.progress?.pullRequestUrl).toBe("https://github.com/acme/repo/pull/17");
            yield* refresh;
            expect(publishing.counts()).toEqual({ commits: 1, pushes: 1 });
            expect(publishing.prCounts().creates).toBe(1);
          }),
        );
      }).pipe(Effect.provide(pgLayer)),
    15000,
  );
});
