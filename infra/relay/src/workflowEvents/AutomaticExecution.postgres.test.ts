import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/unstable/http";
import { EnvironmentId } from "@t3tools/contracts";
import { RelayCloudDispatchJobRequest } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import { layer as machines } from "../machines/Machines.ts";
import { layer as repositories } from "../tenancy/Repositories.ts";
import { layer as organizations } from "../tenancy/Organizations.ts";
import { layer as catalog } from "../projects/OrganizationProjectCatalog.ts";
import {
  EnvironmentConnector,
  layer as connectorLayer,
} from "../environments/EnvironmentConnector.ts";
import { EnvironmentLinks } from "../environments/EnvironmentLinks.ts";
import { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";
import { RepositoryPolicyControl } from "../tenancy/RepositoryPolicies.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { Workflows, make as makeWorkflows } from "../jobs/Workflows.ts";
import { refreshWorkflowJob } from "../jobs/WorkflowDispatcher.ts";
import { databaseUrl, withDatabase } from "../workflowSources/test-fixture.ts";
import * as Store from "../workflowSources/Store.ts";
import {
  configured,
  webhookConfig,
  seed,
  enableBeforeEvent,
  receive,
  clock,
  issue,
} from "./test-fixture.ts";
import * as Routing from "./Routing.ts";
import * as Automatic from "./AutomaticOffer.ts";
import { cloudDispatchJobHandler } from "../../../../apps/server/src/cloud/http.ts";
import {
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
} from "../../../../apps/server/src/cloud/config.ts";
import { WorkflowActions } from "../../../../apps/server/src/jobs/WorkflowActions.ts";
import { RepositoryAccess } from "../../../../apps/server/src/auth/RepositoryAccess.ts";
import {
  harness,
  workflowAccess,
  test as withRunner,
  PROJECT,
  workflow,
} from "../../../../apps/server/src/jobs/RepositoryWorkflowRunner.test-fixture.ts";
import { harness as publishingHarness } from "../../../../apps/server/src/jobs/WorkflowActions.test-fixture.ts";
if (!databaseUrl) throw new Error("Automatic execution proof requires disposable PostgreSQL.");
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RelayCloudDispatchJobRequest));
it.live(
  "signed Linear event reaches the real signed executor, human review and exactly one published PR",
  () =>
    withDatabase(
      configured(
        withRunner(
          Effect.gen(function* () {
            yield* seed;
            yield* enableBeforeEvent("flow");
            const payload = issue(yield* clock);
            expect((yield* receive(payload)).status).toBe(200);
            const store = yield* makeWorkflows;
            const [admitted] = yield* store.listJobs("repo");
            const jobId = admitted!.jobId;
            const h = yield* harness;
            yield* Ref.set(h.branch, `t3-job/${jobId}`);
            const auth = yield* workflowAccess(h, "org", "repo");
            const relayKeys = NodeCrypto.generateKeyPairSync("ed25519", {
              privateKeyEncoding: { format: "pem", type: "pkcs8" },
              publicKeyEncoding: { format: "pem", type: "spki" },
            });
            const environmentKeys = NodeCrypto.generateKeyPairSync("ed25519", {
              privateKeyEncoding: { format: "pem", type: "pkcs8" },
              publicKeyEncoding: { format: "pem", type: "spki" },
            });
            const bytes = (value: string) => new TextEncoder().encode(value);
            yield* auth.secrets.set(CLOUD_MINT_PUBLIC_KEY, bytes(relayKeys.publicKey));
            yield* auth.secrets.set(RELAY_ISSUER_SECRET, bytes("https://relay.test"));
            yield* auth.secrets.set(
              "cloud-link-ed25519-key-pair",
              bytes(Store.json(environmentKeys)),
            );
            const sql = (yield* RelayDb).$client;
            yield* sql`UPDATE relay_repository_aliases SET canonical_key='github.com/acme/repo' WHERE repository_id='repo'`;
            yield* sql`UPDATE relay_organization_projects SET project_id=${PROJECT},repository_canonical_key='github.com/acme/repo' WHERE repository_canonical_key='github.com/example/repository'`;
            yield* sql`UPDATE relay_machines SET environment_public_key=${environmentKeys.publicKey},endpoint_http_base_url='http://127.0.0.1:4444',endpoint_ws_base_url='ws://127.0.0.1:4444/ws',endpoint_provider_kind='manual' WHERE machine_id='machine'`;
            yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role) VALUES ('org','bob','member')`;
            yield* sql`INSERT INTO relay_repository_access(repository_id,user_id,organization_id,role) VALUES ('repo','bob','org','maintainer')`;
            const previous = (yield* store.get("flow"))!;
            const definition = {
              ...previous.definition,
              projectId: PROJECT,
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
            };
            yield* store.save(
              "org",
              "repo",
              {
                workflowId: "flow",
                expectedRevision: previous.revision,
                definition,
                archived: false,
              },
              {
                userId: "maintainer",
                proof: {
                  epoch: 1,
                  connectionId: "connection",
                  generation: "coverage-1",
                  triggerKey: Routing.triggerKey(previous.automation!.trigger),
                  targetKey: Routing.targetKey(definition),
                  canonicalKey: "github.com/acme/repo",
                },
              },
            );
            const publishing = yield* publishingHarness("none", {
              jobId,
              base: "base-sha",
              tree: "prepared-tree",
              remoteName: "origin",
              access: auth.access,
              onHead: (sha) => Ref.set(h.head, sha),
            });
            const runner = yield* h.newRunner.pipe(
              Effect.provideService(RepositoryAccess, auth.access),
              Effect.provideService(WorkflowActions, publishing.actions),
            );
            const transportScope = yield* Scope.Scope;
            const crypto = yield* Crypto.Crypto;
            let issueReads = 0;
            const http = HttpClient.make((request) =>
              Effect.gen(function* () {
                if (request.url === "https://api.linear.app/graphql") {
                  issueReads++;
                  return HttpClientResponse.fromWeb(
                    request,
                    Response.json({
                      data: {
                        organization: { id: "workspace" },
                        issue: {
                          id: "issue",
                          identifier: "ENG-1",
                          title: "Implement feature",
                          description: "Preserved requirements",
                          url: "https://linear.app/test/issue/ENG-1",
                          updatedAt: "2026-10-19T00:00:00Z",
                          team: { id: "team", name: "Engineering" },
                          state: { id: "ready", name: "Ready" },
                          labels: { nodes: [], pageInfo: { hasNextPage: false } },
                        },
                      },
                    }),
                  );
                }
                const envelope = decodeRequest(
                  request.body._tag === "Uint8Array"
                    ? new TextDecoder().decode(request.body.body)
                    : "{}",
                );
                const response = yield* cloudDispatchJobHandler(
                  {
                    secrets: auth.secrets,
                    environment: {
                      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
                      getDescriptor: Effect.die("unused"),
                    },
                    jobRunner: { run: () => Effect.die("Personal dispatch is forbidden") },
                    snapshotQuery: auth.query,
                    repositoryIdentity: auth.identities,
                    workflowRunner: runner,
                  },
                  envelope,
                  true,
                ).pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(
                      new Request("http://127.0.0.1:4444/api/t3-connect/workflow-job", {
                        method: "POST",
                      }),
                    ),
                  ),
                  Effect.provideService(Scope.Scope, transportScope),
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.orDie,
                );
                return HttpClientResponse.fromWeb(request, Response.json(response));
              }),
            );
            const config = {
              ...webhookConfig,
              cloudMintPrivateKey: Redacted.make(relayKeys.privateKey),
              cloudMintPublicKey: relayKeys.publicKey,
              allowLocalMachineEndpoints: true,
            };
            const connector = yield* EnvironmentConnector.pipe(
              Effect.provide(
                connectorLayer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.mock(EnvironmentLinks)({}),
                      Layer.mock(ManagedEndpointAllocations)({ get: () => Effect.succeed(null) }),
                      Layer.succeed(RepositoryPolicyControl, { synchronize: () => Effect.void }),
                      Layer.mock(UserDirectory)({}),
                    ),
                  ),
                ),
              ),
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(RelayConfiguration, config),
            );
            const runtime = Automatic.layer.pipe(
              Layer.provideMerge(
                Layer.merge(
                  Layer.succeed(Workflows, store),
                  Layer.succeed(EnvironmentConnector, connector),
                ),
              ),
            );
            const refresh = refreshWorkflowJob(jobId).pipe(
              Effect.provide(runtime),
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(RelayConfiguration, config),
            );
            // Construct the connector under the same fixture transport/config as its requests.
            const program = Effect.gen(function* () {
              expect((yield* refresh)!.status).toBe("preparing");
              const offered = (yield* store.getJob(jobId))!.record;
              expect(offered.instruction).toContain("Preserved requirements");
              yield* h.awaitPrompt;
              expect((yield* h.starts)[0]!.author).toBeUndefined();
              yield* Store.withdraw("owner", "grant");
              yield* h.complete;
              const review = (yield* refresh)!.progress!;
              expect(review.status, review.detail ?? "").toBe("awaiting_review");
              const row = (yield* store.getJob(jobId))!;
              yield* store.updateJob(row, row.record, {
                userId: "bob",
                response: {
                  operation: "approve",
                  checkpointId: review.checkpoint!.checkpointId,
                  expectedRevision: review.revision,
                },
              });
              yield* refresh;
              yield* h.awaitRun((run) => run.jobId === jobId && run.progress.status === "done");
              const done = (yield* refresh)!;
              expect(done.status).toBe("done");
              expect(done.progress!.pullRequestUrl).toBe("https://github.com/acme/repo/pull/17");
              expect(publishing.prCounts().creates).toBe(1);
              expect(publishing.counts()).toEqual({ commits: 1, pushes: 1 });
              expect(done.issueSnapshot).toEqual(offered.issueSnapshot);
              expect(issueReads).toBe(1);
              expect((yield* receive(payload)).status).toBe(200);
              yield* refresh;
              expect(publishing.prCounts().creates).toBe(1);
              expect(yield* store.listJobs("repo")).toHaveLength(1);
            });
            yield* program.pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(RelayConfiguration, config),
            );
          }),
        ).pipe(Effect.provide([machines, repositories, organizations, catalog])),
      ),
    ),
  15000,
);
