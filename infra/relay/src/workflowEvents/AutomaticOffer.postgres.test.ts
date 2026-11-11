import * as Routing from "./Routing.ts";
import { layer as organizations } from "../tenancy/Organizations.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import {
  EnvironmentConnector,
  EnvironmentMintRequestTimedOut,
} from "../environments/EnvironmentConnector.ts";
import { layer as machines } from "../machines/Machines.ts";
import { layer as repositories } from "../tenancy/Repositories.ts";
import { layer as catalog } from "../projects/OrganizationProjectCatalog.ts";
import { Workflows, make as makeWorkflows } from "../jobs/Workflows.ts";
import { refreshWorkflowJob } from "../jobs/WorkflowDispatcher.ts";
import { refreshWorkflowJobForClient, respondToWorkflowJob } from "../http/WorkflowsApi.ts";
import { RelayDb } from "../db.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Sources from "../workflowSources/Sources.ts";
import * as Issue from "../workflowSources/IssueContext.ts";
import { databaseUrl, withDatabase, transport } from "../workflowSources/test-fixture.ts";
import {
  configured,
  seed,
  enableBeforeEvent,
  receive,
  clock,
  issue,
  save,
  trigger,
} from "./test-fixture.ts";
import * as Automatic from "./AutomaticOffer.ts";
if (!databaseUrl)
  throw new Error("Automatic offer tests require disposable WORKFLOW_SOURCES_TEST_DATABASE_URL.");
const testDb = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  withDatabase(
    configured(program.pipe(Effect.provide([machines, repositories, catalog, organizations]))),
  );
const rawIssue = {
  id: "issue",
  identifier: "ENG-1",
  title: "Implement feature",
  description: "Exact requirements",
  url: "https://linear.app/test/issue/ENG-1",
  updatedAt: "2026-10-19T12:00:00.000Z",
  team: { id: "team", name: "Backend" },
  state: { id: "ready", name: "Ready" },
  labels: { nodes: [{ id: "label", name: "Bug" }], pageInfo: { hasNextPage: false } },
};
const reply = (value: unknown = rawIssue) => ({
  data: { organization: { id: "workspace" }, issue: value },
});
const harness = Effect.gen(function* () {
  yield* seed;
  yield* enableBeforeEvent("flow");
  expect((yield* receive(issue(yield* clock))).status).toBe(200);
  const store = yield* makeWorkflows;
  const [job] = yield* store.listJobs("repo");
  const mode = yield* Ref.make<"accepted" | "busy" | "lost">("accepted");
  const starts = yield* Ref.make<string[]>([]);
  const beforePreparedStart = yield* Ref.make(Effect.void);
  const probes = yield* Ref.make(0);
  const cancellations = yield* Ref.make(0);
  const connector = Layer.mock(EnvironmentConnector)({
    dispatchJob: (input) =>
      Effect.gen(function* () {
        if (input.workflowControl?.operation === "cancel")
          yield* Ref.update(cancellations, (count) => count + 1);
        if (
          input.workflowControl?.operation === "status" &&
          (yield* Ref.updateAndGet(probes, (count) => count + 1)) === 2
        )
          yield* yield* Ref.get(beforePreparedStart);
        if (input.workflowControl?.operation === "start") {
          yield* Ref.update(starts, (values) => [...values, input.instruction]);
          const current = yield* Ref.get(mode);
          if (current === "lost")
            return yield* new EnvironmentMintRequestTimedOut({
              environmentId: input.environmentId,
              operation: "dispatch-job",
              timeoutMs: 5000,
            });
          if (current === "busy")
            return {
              accepted: false,
              workflowResult: {
                protocol: 9 as const,
                outcome: "busy" as const,
                detail: null,
                progress: null,
              },
            };
          return {
            accepted: true,
            workflowResult: {
              protocol: 9 as const,
              outcome: "accepted" as const,
              detail: null,
              progress: {
                revision: 1,
                status: "preparing" as const,
                threadId: ThreadId.make("thread"),
                checkpoint: null,
                detail: null,
              },
            },
          };
        }
        return {
          accepted: false,
          workflowResult: {
            protocol: 9 as const,
            outcome:
              input.workflowControl?.operation === "cancel"
                ? ("cancelled" as const)
                : ("missing" as const),
            detail: null,
            progress: null,
          },
        };
      }),
  });
  const base = Layer.mergeAll(Layer.succeed(Workflows, store), connector);
  const runtime = Automatic.layer.pipe(Layer.provideMerge(base));
  return {
    store,
    jobId: job!.jobId,
    mode,
    starts,
    cancellations,
    beforePreparedStart,
    base,
    runtime,
    refresh: refreshWorkflowJob(job!.jobId).pipe(Effect.provide(runtime)),
    row: store.getJob(job!.jobId),
  };
});

describe("automatic offers (PostgreSQL)", () => {
  it.live(
    "reads the exact issue and commits a snapshot before delivering one concurrent start",
    () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          const reads: string[] = [];
          const http = transport((req) => {
            reads.push(req.url);
            return Response.json(reply());
          });
          const result = yield* Effect.all([h.refresh, h.refresh], {
            concurrency: "unbounded",
          }).pipe(Effect.provide(http));
          expect(result.some((job) => job?.status === "preparing")).toBe(true);
          const row = (yield* h.row)!;
          expect(row.record.issueSnapshot).toMatchObject({
            issueId: "issue",
            description: "Exact requirements",
            authorizationEpoch: 1,
          });
          expect(row.record.startAttempted).toBe(true);
          expect(row.record.offerAuthority).toEqual({ authorizationEpoch: 1, grantGeneration: 1 });
          expect(row.record.instruction).toContain("Exact requirements");
          expect(reads).toHaveLength(1);
          expect(yield* Ref.get(h.starts)).toEqual([row.record.instruction]);
          const page = yield* h.store.pageJobs("repo", { view: "active" });
          expect(page.jobs[0]!.instruction).toBe("ENG-1: Implement feature");
          expect(Store.json(page)).not.toContain("Exact requirements");
        }),
      ),
  );
  it.live(
    "keeps a lost offer frozen after a later busy reply, source withdrawal and issue edits",
    () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          yield* Ref.set(h.mode, "lost");
          yield* h.refresh.pipe(Effect.provide(transport(() => Response.json(reply()))));
          const offered = (yield* h.row)!.record;
          expect(offered.startAttempted).toBe(true);
          yield* Store.withdraw("maintainer", "grant", "repo");
          yield* Ref.set(h.mode, "busy");
          yield* h.refresh.pipe(
            Effect.provide(
              transport(() => {
                throw new Error("Frozen offers must not refetch Linear");
              }),
            ),
          );
          const frozen = (yield* h.row)!.record;
          expect(frozen.status).toBe("dispatching");
          expect(frozen.workflow).toEqual(offered.workflow);
          expect(frozen.issueSnapshot).toEqual(offered.issueSnapshot);
          expect(frozen.instruction).toBe(offered.instruction);
          expect(yield* Ref.get(h.starts)).toEqual([offered.instruction, offered.instruction]);
          yield* h.store.updateJob(
            (yield* h.row)!,
            { ...frozen, status: "cancelling" },
            { userId: "owner", response: { operation: "cancel" } },
          );
        }),
      ),
  );
  it.live.each([false, true])(
    "clears a first-attempt busy refusal and rechecks the original grant (withdrawn: %s)",
    (withdrawn) =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          yield* Ref.set(h.mode, "busy");
          yield* h.refresh.pipe(Effect.provide(transport(() => Response.json(reply()))));
          const queued = (yield* h.row)!;
          expect(queued.record.workflow).toBeNull();
          expect(queued.record.issueSnapshot).toBeUndefined();
          expect(queued.repositoryCanonicalKey).toBeNull();
          expect(queued.record.instruction).not.toContain("Exact requirements");
          yield* h.store.updateJob(queued, { ...queued.record, queueReason: null });
          if (withdrawn) yield* Store.withdraw("maintainer", "grant", "repo");
          yield* Ref.set(h.mode, "accepted");
          yield* h.refresh.pipe(
            Effect.provide(
              transport(() =>
                Response.json(reply({ ...rawIssue, description: "New requirements" })),
              ),
            ),
          );
          const current = (yield* h.row)!.record;
          if (withdrawn) {
            expect(current.queueReason?.code).toBe("source_withdrawn");
            expect(yield* Ref.get(h.starts)).toHaveLength(1);
          } else {
            expect(current.instruction).toContain("New requirements");
          }
        }),
      ),
  );
  for (const operation of ["withdraw", "disconnect", "cancel"] as const)
    it.live(`does not offer when ${operation} wins during a gated issue read`, () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          const ready = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const http = HttpClient.make((req) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(ready, undefined);
              yield* Deferred.await(release);
              return HttpClientResponse.fromWeb(req, Response.json(reply()));
            }),
          );
          const fiber = yield* h.refresh.pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.forkChild,
          );
          yield* Deferred.await(ready);
          if (operation === "withdraw") yield* Store.withdraw("maintainer", "grant", "repo");
          if (operation === "disconnect")
            yield* Sources.disconnect("org", "admin", "connection", 1);
          if (operation === "cancel") {
            const row = (yield* h.row)!;
            yield* h.store.updateJob(row, { ...row.record, status: "cancelled" }, null);
          }
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          expect(yield* Ref.get(h.starts)).toEqual([]);
          expect((yield* h.row)!.record.workflow).toBeNull();
          if (operation === "cancel") expect((yield* h.row)!.record.status).toBe("cancelled");
        }),
      ),
    );
  for (const [change, reason] of [
    ["withdraw", "source_withdrawn"],
    ["disconnect", "source_reconnect"],
    ["cutover", "source_withdrawn"],
    ["off", null],
    ["criteria", null],
    ["archive", "workflow_unavailable"],
    ["target", "target_invalid"],
  ] as const)
    it.live(`rechecks the prepared offer after the executor probe when ${change} wins`, () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          const ready = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(
            h.beforePreparedStart,
            Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
          const refresh = yield* h.refresh.pipe(
            Effect.provide(transport(() => Response.json(reply()))),
            Effect.forkChild,
          );
          yield* Deferred.await(ready);
          expect((yield* h.row)!.record).toMatchObject({
            status: "dispatching",
            startAttempted: false,
          });
          if (change === "withdraw") yield* Store.withdraw("maintainer", "grant", "repo");
          if (change === "disconnect") yield* Sources.disconnect("org", "admin", "connection", 1);
          if (change === "cutover") {
            const sql = (yield* RelayDb).$client;
            yield* sql`DELETE FROM relay_workflow_repository_grants WHERE grant_id='grant'`;
          }
          if (change === "archive") {
            const workflow = (yield* h.store.get("flow"))!;
            yield* h.store.save(
              "org",
              "repo",
              {
                workflowId: workflow.workflowId,
                expectedRevision: workflow.revision,
                definition: workflow.definition,
                archived: true,
              },
              { userId: "maintainer" },
            );
          }
          if (change === "target")
            yield* (yield* RelayDb)
              .$client`DELETE FROM relay_organization_projects WHERE project_id='project'`;
          if (change === "off") yield* save("flow", trigger, false);
          if (change === "criteria") yield* save("flow", { ...trigger, labelIds: ["unmatched"] });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(refresh);
          const row = (yield* h.row)!;
          if (reason === null) {
            expect(row.record.status).toBe("preparing");
            expect(yield* Ref.get(h.starts)).toHaveLength(1);
          } else {
            expect(yield* Ref.get(h.starts)).toEqual([]);
            expect(row.record).toMatchObject({ status: "queued", workflow: null });
            expect(row.record.queueReason?.code).toBe(reason);
            yield* h.store.updateJob(
              row,
              { ...row.record, status: "cancelling" },
              {
                userId: "maintainer",
                response: { operation: "cancel" },
              },
            );
            expect((yield* h.refresh)?.status).toBe("cancelled");
          }
        }),
      ),
    );
  it.live(
    "settles a prepared cancellation only while its requester can maintain the repository",
    () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          const ready = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(
            h.beforePreparedStart,
            Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
          const refresh = yield* h.refresh.pipe(
            Effect.provide(transport(() => Response.json(reply()))),
            Effect.forkChild,
          );
          yield* Deferred.await(ready);
          const frozen = (yield* h.row)!.record;
          expect(frozen).toMatchObject({ status: "dispatching", startAttempted: false });
          const cancel = (userId: string) =>
            respondToWorkflowJob(
              { repositoryId: "repo", jobId: h.jobId },
              { operation: "cancel" },
            ).pipe(
              Effect.provide(h.base),
              Effect.provideService(RelayClientPrincipal, { userId, token: "fixture" }),
            );
          expect((yield* cancel("maintainer")).status).toBe("cancelling");
          yield* (yield* RelayDb)
            .$client`UPDATE relay_repository_access SET role='developer' WHERE organization_id='org' AND repository_id='repo' AND user_id='maintainer'`;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(refresh);

          const restored = yield* h.refresh;
          expect(restored).toMatchObject({
            status: "dispatching",
            startAttempted: false,
            workflow: frozen.workflow,
            issueSnapshot: frozen.issueSnapshot,
          });
          expect(restored?.detail).toContain("no longer has permission");
          expect((yield* h.row)?.pendingControl).toBeNull();
          expect(yield* Ref.get(h.starts)).toEqual([]);
          expect(yield* Ref.get(h.cancellations)).toBe(0);

          expect((yield* cancel("owner")).status).toBe("cancelling");
          expect((yield* h.refresh)?.status).toBe("cancelled");
          expect(yield* Ref.get(h.starts)).toEqual([]);
          expect(yield* Ref.get(h.cancellations)).toBe(0);
        }),
      ),
  );
  for (const change of ["team", "status", "labels", "identifier"] as const)
    it.live(`does not rematch after an issue ${change} change`, () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          const modified = {
            ...rawIssue,
            ...(change === "team"
              ? { team: { id: "other-team", name: "Frontend" } }
              : change === "status"
                ? { state: { id: "done", name: "Done" } }
                : change === "identifier"
                  ? { identifier: "UI-9", url: "https://linear.app/test/issue/UI-9" }
                  : { labels: { nodes: [], pageInfo: { hasNextPage: false } } }),
          };
          yield* h.refresh.pipe(Effect.provide(transport(() => Response.json(reply(modified)))));
          const saved = (yield* h.row)!.record;
          expect(saved.status).toBe("preparing");
          expect(saved.event!.teamId).toBe("team");
          expect(saved.issueSnapshot!.team.id).toBe(modified.team.id);
        }),
      ),
    );
  for (const [name, value, code] of [
    ["missing", null, "issue_unavailable"],
    ["wrong identity", { ...rawIssue, id: "different" }, "issue_context_invalid"],
    [
      "incomplete labels",
      { ...rawIssue, labels: { ...rawIssue.labels, pageInfo: { hasNextPage: true } } },
      "issue_context_invalid",
    ],
    [
      "oversized description",
      { ...rawIssue, description: "x".repeat(32_001) },
      "issue_context_too_large",
    ],
    [
      "unsafe URL",
      { ...rawIssue, url: "https://external.test/issue/ENG-1" },
      "issue_context_invalid",
    ],
    ["missing description field", { ...rawIssue, description: undefined }, "issue_context_invalid"],
  ] as const)
    it.live(`leaves ${name} issue context queued with an actionable reason`, () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          yield* h.refresh.pipe(Effect.provide(transport(() => Response.json(reply(value)))));
          const row = (yield* h.row)!;
          expect(row.record.status).toBe("queued");
          expect(row.record.queueReason?.code).toBe(code);
          expect(yield* Ref.get(h.starts)).toEqual([]);
          const attention = yield* h.store.pageJobs("repo", { view: "attention" });
          expect(attention.jobs.map((j) => j.jobId)).toContain(h.jobId);
          expect((yield* Store.connection("connection"))!.health.code).toBe("healthy");
        }),
      ),
    );
  it.live("accepts an empty description and enforces the exact complete-instruction limit", () =>
    testDb(
      Effect.gen(function* () {
        const c = yield* Store.connection("connection");
        expect(c).toBeNull();
        yield* seed;
        const connection = (yield* Store.connection("connection"))!;
        const empty = yield* Issue.readIssue(connection, "issue").pipe(
          Effect.provide(transport(() => Response.json(reply({ ...rawIssue, description: null })))),
        );
        const room = 32_000 - empty.instruction.length;
        const atLimit = yield* Issue.readIssue(connection, "issue").pipe(
          Effect.provide(
            transport(() => Response.json(reply({ ...rawIssue, description: "x".repeat(room) }))),
          ),
        );
        expect(atLimit.instruction.length).toBe(32_000);
        const tooLong = yield* Issue.readIssue(connection, "issue").pipe(
          Effect.provide(
            transport(() =>
              Response.json(reply({ ...rawIssue, description: "x".repeat(room + 1) })),
            ),
          ),
          Effect.flip,
        );
        expect(tooLong).toMatchObject({ code: "issue_context_too_large" });
      }),
    ),
  );
  it.live("does not let an expired worker apply a late acceptance or erase a newer lease", () =>
    testDb(
      Effect.gen(function* () {
        const h = yield* harness;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const connector = Layer.mock(EnvironmentConnector)({
          dispatchJob: (input) =>
            Effect.gen(function* () {
              if (input.workflowControl?.operation === "start") {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return {
                  accepted: true,
                  workflowResult: {
                    protocol: 9 as const,
                    outcome: "accepted" as const,
                    detail: null,
                    progress: {
                      revision: 1,
                      status: "preparing" as const,
                      threadId: ThreadId.make("thread"),
                      checkpoint: null,
                      detail: null,
                    },
                  },
                };
              }
              return {
                accepted: false,
                workflowResult: {
                  protocol: 9 as const,
                  outcome: "missing" as const,
                  detail: null,
                  progress: null,
                },
              };
            }),
        });
        const base = Layer.merge(Layer.succeed(Workflows, h.store), connector);
        const runtime = Automatic.layer.pipe(Layer.provideMerge(base));
        const fiber = yield* refreshWorkflowJob(h.jobId).pipe(
          Effect.provide(runtime.pipe(Layer.provideMerge(transport(() => Response.json(reply()))))),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        const sql = (yield* RelayDb).$client;
        yield* sql`UPDATE relay_workflow_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=${h.jobId}`;
        const replacement = (yield* h.store.claim(h.jobId))!;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        const current = (yield* h.row)!;
        expect(current.leaseUntil).toBe(replacement.leaseUntil);
        expect(current.record.progress).toBeNull();
        expect(current.record.status).toBe("dispatching");
        yield* h.store.release(h.jobId, replacement.leaseUntil!);
      }),
    ),
  );
  it.live(
    "returns durable automatic state without awaiting a provider from the HTTP refresh path",
    () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          const result = yield* refreshWorkflowJobForClient(h.jobId).pipe(Effect.provide(h.base));
          expect(result!.status).toBe("queued");
          expect(yield* Ref.get(h.starts)).toEqual([]);
        }),
      ),
  );
  it.live("rechecks a workflow edit while reading and adopts it only on a later fresh offer", () =>
    testDb(
      Effect.gen(function* () {
        const h = yield* harness;
        const ready = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const http = HttpClient.make((req) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(release);
            return HttpClientResponse.fromWeb(req, Response.json(reply()));
          }),
        );
        const fiber = yield* h.refresh.pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        const old = (yield* h.store.get("flow"))!;
        yield* h.store.save(
          "org",
          "repo",
          {
            workflowId: "flow",
            expectedRevision: old.revision,
            definition: { ...old.definition, name: "New steps" },
            archived: false,
          },
          {
            userId: "maintainer",
            proof: {
              epoch: 1,
              connectionId: "connection",
              generation: "coverage-1",
              triggerKey: Routing.triggerKey(old.automation!.trigger),
              targetKey: Routing.targetKey(old.definition),
              canonicalKey: "github.com/example/repository",
            },
          },
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        expect(yield* Ref.get(h.starts)).toEqual([]);
        const row = (yield* h.row)!;
        yield* h.store.updateJob(row, { ...row.record, queueReason: null });
        yield* h.refresh.pipe(Effect.provide(transport(() => Response.json(reply()))));
        expect((yield* h.row)!.record.workflow!.definition.name).toBe("New steps");
      }),
    ),
  );
  it.live(
    "rejects context from an old authorization epoch but allows a fresh read after reconnect",
    () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          const ready = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const http = HttpClient.make((req) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(ready, undefined);
              yield* Deferred.await(release);
              return HttpClientResponse.fromWeb(req, Response.json(reply()));
            }),
          );
          const fiber = yield* h.refresh.pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.forkChild,
          );
          yield* Deferred.await(ready);
          const sql = (yield* RelayDb).$client;
          yield* sql`UPDATE relay_workflow_connections SET authorization_epoch=authorization_epoch+1 WHERE connection_id='connection'`;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          expect(yield* Ref.get(h.starts)).toEqual([]);
          const row = (yield* h.row)!;
          yield* h.store.updateJob(row, { ...row.record, queueReason: null });
          yield* h.refresh.pipe(Effect.provide(transport(() => Response.json(reply()))));
          expect((yield* h.row)!.record.issueSnapshot!.authorizationEpoch).toBe(2);
        }),
      ),
  );
  it.live(
    "respects persisted provider backoff across job refreshes without breaking source credentials",
    () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          let calls = 0;
          const limited = transport(() => {
            calls++;
            return Response.json(
              { errors: [{ extensions: { code: "RATELIMITED" } }] },
              { status: 400, headers: { "retry-after": "60" } },
            );
          });
          yield* h.refresh.pipe(Effect.provide(limited));
          expect((yield* h.row)!.record.queueReason!.code).toBe("source_rate_limited");
          expect((yield* Store.connection("connection"))!.status).toBe("connected");
          yield* h.refresh.pipe(Effect.provide(limited));
          expect(calls).toBe(1);
          expect((yield* h.store.pendingJobs()).map((j) => j.jobId)).not.toContain(h.jobId);
          expect((yield* h.store.pageJobs("repo", { view: "attention" })).jobs).toHaveLength(0);
        }),
      ),
  );
  it.live(
    "refreshes an expired access token once and retains the successful read's credential provenance",
    () =>
      testDb(
        Effect.gen(function* () {
          const h = yield* harness;
          let reads = 0;
          let refreshes = 0;
          const http = transport((request) => {
            if (request.url.endsWith("/oauth/token")) {
              refreshes++;
              return Response.json({
                access_token: "rotated",
                refresh_token: "refresh",
                expires_in: 86400,
                token_type: "Bearer",
                scope: "read",
              });
            }
            reads++;
            return reads === 1 ? Response.json({}, { status: 401 }) : Response.json(reply());
          });
          yield* h.refresh.pipe(Effect.provide(http));
          expect(refreshes).toBe(1);
          expect(reads).toBe(2);
          expect((yield* h.row)!.record.issueSnapshot!.credentialVersion).toBe(2);
        }),
      ),
  );
});
