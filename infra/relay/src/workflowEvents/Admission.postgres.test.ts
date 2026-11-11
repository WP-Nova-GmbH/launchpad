import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { CurrentTransformer } from "effect/unstable/sql/Statement";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import * as Workflows from "../jobs/Workflows.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntimeConfiguration.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Sources from "../workflowSources/Sources.ts";
import {
  databaseUrl,
  withDatabase,
  tokenReply,
  identityReply,
  transport,
} from "../workflowSources/test-fixture.ts";
import * as Fence from "./Fence.ts";
import * as Routing from "./Routing.ts";
import { admit } from "./Admission.ts";
import { normalize } from "./Linear.ts";
import {
  configured,
  webhookConfig,
  seed,
  clock,
  issue,
  revocation,
  trigger,
  definition,
  save,
  enableBeforeEvent,
  receive,
  counts,
  sign,
} from "./test-fixture.ts";
if (!databaseUrl)
  throw new Error(
    "Admission tests require WORKFLOW_SOURCES_TEST_DATABASE_URL pointing to disposable PostgreSQL.",
  );
const decodeProof = Schema.decodeUnknownEffect(Routing.EnableProof);
const testDb = <A, E, R>(effect: Effect.Effect<A, E, R>) => withDatabase(configured(effect));
const gateExchange = Effect.fn(function* (state: string) {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const callback = Sources.callback(state, "code").pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((req) =>
        req.url.endsWith("/oauth/token")
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(HttpClientResponse.fromWeb(req, Response.json(tokenReply))),
            )
          : Effect.succeed(HttpClientResponse.fromWeb(req, Response.json(identityReply))),
      ),
    ),
  );
  return { entered, release, callback };
});
// Hold the actual production transaction's locks after its writes, then start the contender.
const ordered = Effect.fn(function* <A, E, R, B, F, S>(
  first: Effect.Effect<A, E, R>,
  second: Effect.Effect<B, F, S>,
) {
  const sql = (yield* RelayDb).$client;
  const ready = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const writer = yield* sql
    .withTransaction(
      first.pipe(
        Effect.tap(() => Deferred.succeed(ready, undefined)),
        Effect.tap(() => Deferred.await(release)),
      ),
    )
    .pipe(Effect.forkChild);
  yield* Deferred.await(ready);
  const reader = yield* second.pipe(Effect.forkChild);
  yield* Deferred.succeed(release, undefined);
  return [yield* Fiber.join(writer), yield* Fiber.join(reader)] as const;
});
describe("verified event admission (PostgreSQL)", () => {
  it.live("admits a VM only with execution enabled and pins the established Codex identity", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        yield* enableBeforeEvent("machine");
        const vm = yield* enableBeforeEvent("vm");
        const sql = (yield* RelayDb).$client;
        yield* sql`UPDATE relay_repository_workflows SET record=${sql.json({
          ...vm,
          definition: { ...vm.definition, target: { kind: "vm", baseBranch: null } },
        })} WHERE workflow_id='vm'`;
        const fs = yield* FileSystem.FileSystem;
        const migration = yield* fs.readFileString(
          new URL(
            "../../migrations/postgres/20261028130056_codex_vm_connections/migration.sql",
            import.meta.url,
          ).pathname,
        );
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) yield* sql.unsafe(statement);
        }
        yield* sql`INSERT INTO relay_codex_vm_connections (organization_id,connection_id,status,updated_at)
          VALUES ('org','first','disconnected','2026')`;
        const now = yield* clock;
        const vmReceive = (offset: number) =>
          receive(issue(now + offset)).pipe(
            Effect.provideService(ThreadVmRuntimeConfiguration, {
              settings: {
                compute: {
                  apiUrl: "https://compute.test",
                  sandboxUrl: "https://sandbox.test",
                  apiKey: Redacted.make("fixture"),
                  templateId: "runner:fixture",
                  hostAddresses: ["192.0.2.10"],
                  timeoutMs: 600_000,
                },
                templateBuildId: "fixture",
                workflowExecutionEnabled: true,
                workflowModelCatalog: { defaultModel: "fixture-model", models: [] },
                hostId: "host",
                maxRunningVms: 1,
                publicRelayUrl: "https://relay.test",
                autoPauseEnabled: false,
                autoBackupEnabled: false,
                autoDeleteEnabled: false,
                replacementEnabled: false,
                restoreEnabled: false,
                resetEnabled: false,
              },
            }),
          );
        expect((yield* vmReceive(0)).status).toBe(200);
        expect(yield* counts).toEqual({ occurrences: 1, admissions: 1, jobs: 1 });
        yield* sql`UPDATE relay_codex_vm_connections SET issuer='issuer',subject='subject',client_id='client'`;
        expect((yield* receive(issue(now + 1))).status).toBe(200);
        expect(yield* counts).toEqual({ occurrences: 2, admissions: 2, jobs: 2 });
        const [admitted] = yield* ordered(
          vmReceive(2),
          sql`UPDATE relay_codex_vm_connections SET connection_id='replacement', subject='new-subject',
            status='connected', payload_sealed='fixture', expires_at='2099-01-01'`,
        );
        expect(admitted.status).toBe(200);
        expect((yield* vmReceive(2)).status).toBe(200);
        expect((yield* vmReceive(3)).status).toBe(200);
        expect(yield* counts).toEqual({ occurrences: 4, admissions: 6, jobs: 6 });
        const store = yield* Workflows.make;
        const jobs = (yield* store.listJobs("repo")).filter((j) => j.record.workflowId === "vm");
        expect(jobs).toHaveLength(2);
        const active = yield* store.pageJobs("repo", { view: "active" });
        expect(active.jobs.filter((j) => j.targetKind === "vm")).toHaveLength(2);
        const first = jobs.find((j) => j.record.vmAdmission?.codexConnectionId === "first");
        expect(first).toMatchObject({
          submitterUserId: null,
          record: {
            runtime: null,
            workflow: null,
            status: "queued",
            queueReason: { code: "vm_waiting_codex", retryAt: null },
            origin: {
              kind: "automation",
              source: { grantId: "grant", connectionId: "connection" },
            },
          },
        });
        expect(
          jobs.find((j) => j.record.vmAdmission?.codexConnectionId === "replacement")?.record
            .queueReason,
        ).toBeNull();
      }),
    ),
  );
  it.live(
    "atomically admits every workflow once across concurrent copies and stale authenticated retries",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          yield* enableBeforeEvent("flow-a");
          yield* enableBeforeEvent("flow-b");
          const payload = issue(yield* clock);
          const replies = yield* Effect.forEach(
            [
              payload,
              {
                ...payload,
                webhookId: "another-subscription",
                webhookTimestamp: payload.webhookTimestamp + 1,
              },
            ],
            (p) => receive(p),
            { concurrency: "unbounded" },
          );
          expect(replies.map((r) => r.status)).toEqual([200, 200]);
          expect(yield* counts).toEqual({ occurrences: 1, admissions: 2, jobs: 2 });
          expect(
            (yield* receive(
              { ...payload, webhookTimestamp: payload.webhookTimestamp - 3600000 },
              { "linear-delivery": "different" },
            )).status,
          ).toBe(200);
          const store = yield* Workflows.make;
          const page = yield* store.pageJobs("repo", { view: "active" });
          expect(page.jobs).toHaveLength(2);
          const jobs = yield* store.listJobs("repo");
          for (const j of jobs) {
            expect(j.submitterUserId).toBeNull();
            expect(j.record).toMatchObject({
              requiredProtocol: 9,
              status: "queued",
              workflow: null,
              progress: null,
              origin: { kind: "automation", source: { grantId: "grant" } },
            });
          }
          const fresh = issue(payload.webhookTimestamp + 1);
          expect((yield* receive(fresh)).status).toBe(200);
          expect((yield* counts).jobs).toBe(4);
        }),
      ),
  );
  it.live(
    "never rematches a committed no-match and excludes unknown events before Save or at its timestamp",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const older = issue(yield* clock);
          expect((yield* receive(older)).status).toBe(200);
          const saved = yield* save();
          expect((yield* receive(older)).status).toBe(200);
          expect((yield* receive(issue(Date.parse(saved.updatedAt) - 1))).status).toBe(200);
          expect((yield* receive(issue(Date.parse(saved.updatedAt)))).status).toBe(200);
          expect((yield* counts).jobs).toBe(0);
          expect((yield* receive(issue(Date.parse(saved.updatedAt) + 1))).status).toBe(200);
          expect((yield* counts).jobs).toBe(1);
        }),
      ),
  );
  it.live(
    "preserves cutoffs for equivalent labels and definition edits; changes them only on enable or trigger edits",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          yield* save("flow", { ...trigger, labelIds: ["b", "a"] });
          const before = yield* Routing.read("flow");
          yield* save("flow", { ...trigger, labelIds: ["a", "b", "a"] }, true, "Renamed");
          const same = yield* Routing.read("flow");
          expect(same?.effective_after).toBe(before?.effective_after);
          expect(same?.routing_generation).toBe(1);
          yield* save("flow", { ...trigger, labelIds: ["c"] });
          expect((yield* Routing.read("flow"))?.routing_generation).toBe(2);
          yield* save("flow", { ...trigger, labelIds: ["c"] }, false);
          yield* save("flow", { ...trigger, labelIds: ["c"] }, true);
          expect((yield* Routing.read("flow"))?.routing_generation).toBe(3);
        }),
      ),
  );
  it.live(
    "preserves automation on old Save omission and archive, and rejects routing projection drift",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const a = yield* save();
          const store = yield* Workflows.make;
          const proof = (yield* Routing.read("flow"))!.target_capability;
          const checked = yield* decodeProof(proof);
          const b = yield* store.save(
            "org",
            "repo",
            { workflowId: "flow", expectedRevision: a.revision, definition, archived: false },
            { userId: "maintainer", proof: checked },
          );
          expect(b.automation?.enabled).toBe(true);
          const sql = (yield* RelayDb).$client;
          yield* sql`UPDATE relay_repository_workflows SET record=(record-'automation')||'{"archived":true}'::jsonb WHERE workflow_id='flow'`;
          const archived = yield* store.get("flow");
          expect(archived?.automation).toMatchObject({ enabled: false, trigger });
          yield* sql`UPDATE relay_repository_workflows SET record=record||'{"archived":false}'::jsonb WHERE workflow_id='flow'`;
          expect((yield* Routing.read("flow"))?.record.automation?.enabled).toBe(false);
          expect(
            yield* sql`UPDATE relay_repository_workflows SET automation_enabled=true WHERE workflow_id='flow'`.pipe(
              Effect.exit,
            ),
          ).toMatchObject({ _tag: "Failure" });
        }),
      ),
  );
  for (const mutation of [
    "disable",
    "archive",
    "edit",
    "withdraw",
    "disconnect",
    "installer-departure",
    "repository",
    "organization",
  ] as const) {
    for (const admissionFirst of [true, false]) {
      it.live(
        `${mutation}: ${admissionFirst ? "admission" : "change"} wins its transaction ordering`,
        () =>
          testDb(
            Effect.gen(function* () {
              yield* seed;
              yield* enableBeforeEvent();
              const sql = (yield* RelayDb).$client;
              const payload = issue(yield* clock);
              const event = yield* normalize(payload, "native-app");
              const store = yield* Workflows.make;
              if (mutation === "installer-departure")
                yield* sql`UPDATE relay_workflow_authorizations SET initiating_user_id='admin'`;
              const change =
                mutation === "disable"
                  ? save("flow", trigger, false)
                  : mutation === "archive"
                    ? store.save(
                        "org",
                        "repo",
                        { workflowId: "flow", expectedRevision: 1, definition, archived: true },
                        { userId: "maintainer" },
                      )
                    : mutation === "edit"
                      ? save("flow", { ...trigger, event: "entered_status", stateId: "ready" })
                      : mutation === "withdraw"
                        ? Store.withdraw("maintainer", "grant", "repo")
                        : mutation === "disconnect"
                          ? Sources.disconnect("org", "admin", "connection", 1)
                          : mutation === "installer-departure"
                            ? sql`DELETE FROM relay_organization_members WHERE user_id='admin'`
                            : mutation === "repository"
                              ? sql`DELETE FROM relay_repositories WHERE repository_id='repo'`
                              : sql`DELETE FROM relay_organizations WHERE organization_id='org'`;
              if (admissionFirst)
                yield* ordered(
                  admit(event),
                  Effect.gen(function* () {
                    yield* change;
                  }),
                );
              else
                yield* ordered(
                  Effect.gen(function* () {
                    yield* change;
                  }),
                  admit(event),
                );
              const expected = admissionFirst || mutation === "installer-departure" ? 1 : 0;
              expect((yield* counts).jobs).toBe(expected);
              expect((yield* counts).occurrences).toBe(
                !admissionFirst && (mutation === "disconnect" || mutation === "organization")
                  ? 0
                  : 1,
              );
              expect((yield* receive(payload)).status).toBe(200);
              expect((yield* counts).jobs).toBe(expected);
            }),
          ),
      );
    }
  }
  it.live(
    "rolls back occurrence and all fan-out jobs on a storage fault, then safely retries",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          yield* enableBeforeEvent("a");
          yield* enableBeforeEvent("b");
          const sql = (yield* RelayDb).$client;
          yield* sql.unsafe(
            "CREATE FUNCTION reject_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected admission write failure'; END $$",
          );
          yield* sql.unsafe(
            "CREATE TRIGGER fail_admission BEFORE INSERT ON relay_workflow_admissions FOR EACH ROW EXECUTE FUNCTION reject_admission()",
          );
          const payload = issue(yield* clock);
          expect((yield* receive(payload)).status).toBe(500);
          expect(yield* counts).toEqual({ jobs: 0, admissions: 0, occurrences: 0 });
          yield* sql.unsafe("DROP TRIGGER fail_admission ON relay_workflow_admissions");
          expect((yield* receive(payload)).status).toBe(200);
          expect(yield* counts).toEqual({ jobs: 2, admissions: 2, occurrences: 1 });
        }),
      ),
  );
  it.live("skips revoked candidate authority without dropping valid sibling workflows", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        yield* Store.allow(
          "repo-2",
          "admin",
          { grantId: "grant-2", connectionId: "connection", previousGrantId: null },
          "native-app",
        );
        yield* enableBeforeEvent("valid");
        const sql = (yield* RelayDb).$client;
        yield* sql`INSERT INTO relay_repository_workflows SELECT 'invalid','repo-2',revision,jsonb_set(jsonb_set(jsonb_set(record,'{workflowId}','"invalid"'),'{repositoryId}','"repo-2"'),'{automation,trigger,grantId}','"grant-2"'),automation_enabled,source_application_id,source_workspace_id,trigger_team_id,trigger_event,'grant-2',routing_generation,effective_after,target_capability FROM relay_repository_workflows WHERE workflow_id='valid'`;
        yield* Store.withdraw("admin", "grant-2");
        expect((yield* receive(issue(yield* clock))).status).toBe(200);
        expect((yield* counts).jobs).toBe(1);
      }),
    ),
  );
  it.live(
    "records observed team coverage only for the current generation/epoch; admission defaults off",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const sql = (yield* RelayDb).$client;
          yield* sql`UPDATE relay_workflow_connections SET delivery_evidence=NULL`;
          const off = {
            ...webhookConfig,
            linearWorkflowWebhook: {
              ...webhookConfig.linearWorkflowWebhook,
              admissionEnabled: false,
            },
          };
          const start = issue(yield* clock);
          yield* receive(start).pipe(Effect.provideService(RelayConfiguration, off));
          expect(
            (yield* receive({ ...start, webhookTimestamp: start.webhookTimestamp - 3600000 }).pipe(
              Effect.provideService(RelayConfiguration, off),
            )).status,
          ).toBe(200);
          expect(Fence.covers((yield* Store.connection("connection"))!, "coverage-1", "team")).toBe(
            false,
          );
          yield* receive(
            issue(start.webhookTimestamp + 1, {
              action: "update",
              updatedFrom: { stateId: "todo" },
            }),
          ).pipe(Effect.provideService(RelayConfiguration, off));
          const c = (yield* Store.connection("connection"))!;
          expect(Fence.covers(c, "coverage-1", "team")).toBe(true);
          expect(Fence.covers(c, "coverage-2", "team")).toBe(false);
          expect(Fence.covers({ ...c, authorization_epoch: 2 }, "coverage-1", "team")).toBe(false);
          expect(Fence.covers(c, "coverage-1", "other-team")).toBe(false);
          expect(
            (yield* Store.repositorySnapshot("repo", "maintainer")).sources[0]?.source.delivery,
          ).toBe("verified");
          expect(yield* counts).toEqual({ occurrences: 2, admissions: 0, jobs: 0 });
        }),
      ),
  );
  it.live("cannot complete a team's delivery coverage during a reconnect", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        yield* enableBeforeEvent("flow");
        const sql = (yield* RelayDb).$client;
        const incomplete = {
          generation: "coverage-1",
          epoch: 1,
          teams: { team: { created: false, entered: true } },
        };
        yield* sql`UPDATE relay_workflow_connections SET delivery_evidence=${sql.json(incomplete)}`;
        const pending = yield* Sources.begin("org", "admin", {
          attemptId: "incomplete-coverage",
          expectedVersion: 0,
          connectionId: "connection",
        });
        const gate = yield* gateExchange(
          new URL(pending.authorization!.url).searchParams.get("state")!,
        );
        const callback = yield* gate.callback.pipe(Effect.forkChild);
        yield* Deferred.await(gate.entered);

        expect((yield* receive(issue(yield* clock))).status).toBe(200);
        expect(yield* counts).toEqual({ occurrences: 1, admissions: 0, jobs: 0 });
        expect((yield* Store.connection("connection"))?.delivery_evidence).toEqual(incomplete);

        yield* Deferred.succeed(gate.release, undefined);
        expect(yield* Fiber.join(callback)).toBe("connection");
        expect((yield* Store.connection("connection"))?.delivery_evidence).toBeNull();
      }),
    ),
  );
  it.live(
    "fences first-connection late OAuth callbacks and retains a later authorization through old revocations",
    () =>
      testDb(
        Effect.gen(function* () {
          const sql = (yield* RelayDb).$client;
          const pending = yield* Sources.begin("org", "admin", {
            attemptId: "before-revocation",
            expectedVersion: 0,
            connectionId: null,
          });
          const gate = yield* gateExchange(
            new URL(pending.authorization!.url).searchParams.get("state")!,
          );
          const callback = yield* gate.callback.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(gate.entered);
          const attempt = (yield* Store.attempt("org", "native-app"))!;
          const stamp = Date.parse(attempt.started_at!);
          expect((yield* receive(revocation(stamp))).status).toBe(200);
          expect(
            yield* sql`SELECT facts FROM relay_workflow_occurrences WHERE event_type='revocation'`,
          ).toEqual([{ facts: {} }]);
          yield* Deferred.succeed(gate.release, undefined);
          expect(yield* Fiber.join(callback)).toMatchObject({
            code: "conflict",
          });
          expect(yield* sql`SELECT * FROM relay_workflow_connections`).toHaveLength(0);
          const current = yield* Store.attempt("org", "native-app");
          const later = yield* Sources.begin("org", "admin", {
            attemptId: "later",
            expectedVersion: current!.version,
            connectionId: null,
          });
          const id = yield* Sources.callback(
            new URL(later.authorization!.url).searchParams.get("state")!,
            "code",
          );
          const c = (yield* Store.connection(id))!;
          expect(c.status).toBe("connected");
          expect((yield* receive(revocation(stamp))).status).toBe(200);
          expect((yield* Store.connection(id))?.authorization_epoch).toBe(c.authorization_epoch);
          expect((yield* receive(revocation(stamp - 1))).status).toBe(200);
          expect((yield* Store.connection(id))?.status).toBe("connected");
        }),
      ),
  );
  it.live(
    "revokes only exact app/workspace generations and never revives with a stalled refresh",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          yield* enableBeforeEvent();
          const sql = (yield* RelayDb).$client;
          yield* sql`UPDATE relay_workflow_connections SET health='{"code":"healthy","retryAt":null}',payload_sealed=payload_sealed`;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          // Force refresh via the public credentials boundary; token HTTP deliberately remains in flight.
          const box = yield* RelaySecretBox;
          const sealed = yield* box.seal(
            Store.json({ accessToken: "old", refreshToken: "refresh", expiresAt: 0 }),
          );
          yield* sql`UPDATE relay_workflow_connections SET payload_sealed=${sealed}`;
          const http = HttpClient.make((req) =>
            req.url.endsWith("/oauth/token")
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(HttpClientResponse.fromWeb(req, Response.json(tokenReply))),
                )
              : Effect.succeed(HttpClientResponse.fromWeb(req, Response.json(identityReply))),
          );
          const refresh = yield* Sources.credentials((yield* Store.connection("connection"))!).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.exit,
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          // Receiver must return while refresh HTTP is still held.
          expect((yield* receive(issue(yield* clock))).status).toBe(200);
          expect((yield* counts).jobs).toBe(1);
          expect((yield* receive(revocation(yield* clock))).status).toBe(200);
          expect((yield* Store.connection("connection"))?.status).toBe("reconnect_required");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(refresh);
          expect((yield* Store.connection("connection"))?.payload_sealed).toBeNull();
          expect((yield* counts).jobs).toBe(1);
        }),
      ),
  );
  for (const admissionFirst of [true, false])
    it.live(
      `first enable closes candidate phantom: ${admissionFirst ? "event" : "Save"} wins`,
      () =>
        testDb(
          Effect.gen(function* () {
            yield* seed;
            const event = yield* normalize(issue((yield* clock) + 1000), "native-app");
            if (admissionFirst) yield* ordered(admit(event), save());
            else yield* ordered(save(), admit(event));
            expect((yield* counts).jobs).toBe(admissionFirst ? 0 : 1);
          }),
        ),
    );
  it.live(
    "isolates app revocation and issue deliveries from the old signing secret and unrelated workspaces",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          yield* enableBeforeEvent("one");
          const sql = (yield* RelayDb).$client;
          const now = yield* clock;
          for (const legacy of [{ ...revocation(now), oauthClientId: "legacy-app" }, issue(now)]) {
            const signature = yield* sign(Store.json(legacy), "legacy-webhook-test-secret");
            expect((yield* receive(legacy, { "linear-signature": signature })).status).toBe(401);
          }
          const reconnect = yield* Sources.begin("org", "admin", {
            attemptId: "unrelated-workspace",
            expectedVersion: 0,
            connectionId: "connection",
          });
          expect(
            yield* Sources.callback(
              new URL(reconnect.authorization!.url).searchParams.get("state")!,
              "wrong-workspace-code",
            ).pipe(
              Effect.provide(
                transport((req) =>
                  Response.json(
                    req.url.endsWith("/oauth/token")
                      ? tokenReply
                      : {
                          data: {
                            ...identityReply.data,
                            organization: { id: "other-workspace", name: "Unrelated" },
                          },
                        },
                  ),
                ),
              ),
              Effect.flip,
            ),
          ).toMatchObject({ code: "workspace_mismatch" });
          const connection = yield* Store.connection("connection");
          expect((yield* receive(issue(now, { organizationId: "other-workspace" }))).status).toBe(
            200,
          );
          expect(yield* counts).toEqual({ occurrences: 0, jobs: 0, admissions: 0 });
          expect(yield* Store.connection("connection")).toEqual(connection);
          expect(
            (yield* receive({ ...revocation(now), organizationId: "other-workspace" })).status,
          ).toBe(200);
          expect((yield* Store.connection("connection"))?.status).toBe("connected");
          expect((yield* receive(revocation(now))).status).toBe(200);
          expect((yield* Store.connection("connection"))?.status).toBe("reconnect_required");
          expect(
            yield* sql`SELECT grant_id FROM relay_workflow_repository_grants WHERE NOT revoked`,
          ).toHaveLength(1);
          expect((yield* receive(issue((yield* clock) + 1))).status).toBe(200);
          expect((yield* counts).jobs).toBe(0);
        }),
      ),
  );
  it.live("rejects intake if relay configuration tries to reassign the bound app", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const mismatched = {
          ...webhookConfig,
          linearWorkflow: { ...webhookConfig.linearWorkflow!, organizationId: "other-org" },
          linearWorkflowWebhook: {
            ...webhookConfig.linearWorkflowWebhook,
            organizationId: "other-org",
          },
        };
        const payload = revocation(yield* clock);
        expect(
          (yield* receive(payload).pipe(Effect.provideService(RelayConfiguration, mismatched)))
            .status,
        ).toBe(503);
        expect((yield* counts).occurrences).toBe(0);
        expect((yield* Store.connection("connection"))?.status).toBe("connected");
        expect((yield* receive(payload)).status).toBe(200);
        expect((yield* Store.connection("connection"))?.status).toBe("reconnect_required");
      }),
    ),
  );
  it.live(
    "rejects stale or future deliveries and ignores fresh issues without an installed connection",
    () =>
      testDb(
        Effect.gen(function* () {
          const time = yield* clock;
          expect((yield* receive(issue(time - 61000))).status).toBe(401);
          expect((yield* receive(issue(time + 61000))).status).toBe(401);
          expect((yield* receive(issue(time, { createdAt: Store.iso(time + 61000) }))).status).toBe(
            401,
          );
          expect(yield* counts).toEqual({ occurrences: 0, jobs: 0, admissions: 0 });
          expect((yield* receive(issue(time, { action: "remove", data: undefined }))).status).toBe(
            200,
          );
          expect((yield* counts).occurrences).toBe(0);
          expect((yield* receive(issue(time))).status).toBe(200);
          expect((yield* counts).occurrences).toBe(0);
        }),
      ),
  );
  it.live(
    "admits 500 of 1,000 candidate rules through the production receiver within Linear's deadline",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          yield* enableBeforeEvent("seed");
          const sql = (yield* RelayDb).$client;
          yield* sql`INSERT INTO relay_repository_workflows SELECT 'flow-'||n,repository_id,revision,record||jsonb_build_object('workflowId','flow-'||n,'automation',jsonb_build_object('enabled',true,'trigger',(record#>'{automation,trigger}')||CASE WHEN n>500 THEN '{"labelIds":["missing"]}'::jsonb ELSE '{}'::jsonb END)),automation_enabled,source_application_id,source_workspace_id,trigger_team_id,trigger_event,trigger_grant_id,routing_generation,effective_after,target_capability FROM relay_repository_workflows CROSS JOIN generate_series(1,1000) n WHERE workflow_id='seed'`;
          yield* sql`DELETE FROM relay_repository_workflows WHERE workflow_id='seed'`;
          const started = performance.now();
          const response = yield* receive(issue(yield* clock));
          const elapsed = performance.now() - started;
          expect(response.status).toBe(200);
          expect(yield* counts).toEqual({ jobs: 500, admissions: 500, occurrences: 1 });
          expect(elapsed).toBeLessThan(5000);
          yield* Effect.logInfo(
            `workflow admission: 1000 candidates / 500 matches in ${elapsed.toFixed(1)}ms`,
          );
        }),
      ),
    { timeout: 15000 },
  );
  it.live.each([false, true])(
    "persists a boundary emoji and deduplicates it (matching: %s)",
    (matching) =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          if (matching) yield* enableBeforeEvent();
          const original = issue(yield* clock);
          const payload = {
            ...original,
            data: { ...original.data, title: "a".repeat(119) + "🚀" },
          };
          expect((yield* receive(payload)).status).toBe(200);
          const sql = (yield* RelayDb).$client;
          const [row] = yield* sql<{
            facts: { title: string };
          }>`SELECT facts FROM relay_workflow_occurrences`;
          expect(row?.facts.title).toBe("a".repeat(119));
          expect((yield* receive({ ...payload, webhookTimestamp: yield* clock })).status).toBe(200);
          expect(yield* counts).toEqual({
            occurrences: 1,
            jobs: matching ? 1 : 0,
            admissions: matching ? 1 : 0,
          });
        }),
      ),
  );

  it.live.each(["before exchange", "during exchange", "after commit"] as const)(
    "preserves a newer reconnect when an old revocation arrives %s",
    (arrival) =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const sql = (yield* RelayDb).$client;
          const pending = yield* Sources.begin("org", "admin", {
            attemptId: "later-reconnect",
            connectionId: "connection",
            expectedVersion: 0,
          });
          expect((yield* Store.attempt("org", "native-app"))?.started_at).toBeNull();
          // The event occurred with consent open. Set the later exchange and activation
          // timestamps explicitly so this ordering never depends on the clock advancing.
          const revokedAt = yield* clock;
          let stamp = revokedAt;
          const gate = yield* gateExchange(
            new URL(pending.authorization!.url).searchParams.get("state")!,
          );
          const callback = gate.callback.pipe(
            Effect.provideService(CurrentTransformer, (statement) =>
              Effect.succeed(
                statement.compile()[0].includes("to_char(clock_timestamp()")
                  ? sql`SELECT ${Store.iso(++stamp)}::text AS stamp`
                  : statement,
              ),
            ),
          );
          let fiber = arrival === "before exchange" ? null : yield* callback.pipe(Effect.forkChild);
          if (fiber) yield* Deferred.await(gate.entered);
          if (arrival === "after commit") {
            yield* Deferred.succeed(gate.release, undefined);
            expect(yield* Fiber.join(fiber!)).toBe("connection");
          }
          expect((yield* receive(revocation(revokedAt))).status).toBe(200);
          if (arrival !== "after commit") {
            expect(yield* Store.connection("connection")).toMatchObject({
              status: "reconnect_required",
              payload_sealed: null,
              delivery_evidence: null,
              authorization_epoch: 2,
            });
            expect((yield* Store.attempt("org", "native-app"))?.expected_epoch).toBe(2);
            fiber ??= yield* callback.pipe(Effect.forkChild);
            yield* Deferred.succeed(gate.release, undefined);
            expect(yield* Fiber.join(fiber)).toBe("connection");
          }
          const connected = (yield* Store.connection("connection"))!;
          expect(connected).toMatchObject({
            status: "connected",
            authorization_epoch: arrival === "after commit" ? 2 : 3,
            authorization_started_at: Store.iso(revokedAt + 1),
            activated_at: Store.iso(revokedAt + 2),
            delivery_evidence: null,
          });
          expect(connected.payload_sealed).not.toBeNull();
          expect((yield* receive(revocation(revokedAt))).status).toBe(200);
          expect((yield* receive(revocation(revokedAt - 1))).status).toBe(200);
          expect(yield* Store.connection("connection")).toEqual(connected);
          expect(
            yield* sql`SELECT grant_id FROM relay_workflow_repository_grants WHERE grant_id='grant' AND NOT revoked`,
          ).toHaveLength(1);
          expect((yield* receive(revocation(revokedAt + 1))).status).toBe(200);
          expect((yield* Store.connection("connection"))?.status).toBe("reconnect_required");
        }),
      ),
  );

  it.live("disconnect still cancels a forwarded reconnect during exchange", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const pending = yield* Sources.begin("org", "admin", {
          attemptId: "later-disconnect",
          connectionId: "connection",
          expectedVersion: 0,
        });
        const gate = yield* gateExchange(
          new URL(pending.authorization!.url).searchParams.get("state")!,
        );
        const callback = yield* gate.callback.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(gate.entered);
        const attempt = (yield* Store.attempt("org", "native-app"))!;
        expect((yield* receive(revocation(Date.parse(attempt.started_at!) - 1))).status).toBe(200);
        yield* Sources.disconnect("org", "admin", "connection", 2);
        yield* Deferred.succeed(gate.release, undefined);
        expect(yield* Fiber.join(callback)).toMatchObject({ code: "conflict" });
        expect(yield* Store.connection("connection")).toMatchObject({
          status: "disconnected",
          payload_sealed: null,
        });
      }),
    ),
  );
  it.live.each([0, 1])(
    "blocks reconnect when the revocation occurs %d ms after exchange starts",
    (offset) =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const pending = yield* Sources.begin("org", "admin", {
            attemptId: "blocked",
            expectedVersion: 0,
            connectionId: "connection",
          });
          const gate = yield* gateExchange(
            new URL(pending.authorization!.url).searchParams.get("state")!,
          );
          const callback = yield* gate.callback.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(gate.entered);
          const attempt = (yield* Store.attempt("org", "native-app"))!;
          const boundary = Date.parse(attempt.started_at!);
          expect((yield* receive(revocation(boundary + offset))).status).toBe(200);
          expect((yield* Store.attempt("org", "native-app"))?.expected_epoch).toBe(1);
          yield* Deferred.succeed(gate.release, undefined);
          expect(yield* Fiber.join(callback)).toMatchObject({ code: "conflict" });
          expect((yield* Store.connection("connection"))?.payload_sealed).toBeNull();
        }),
      ),
  );

  it.live("does not forward an expired pending reconnect attempt", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const pending = yield* Sources.begin("org", "admin", {
          attemptId: "expired",
          expectedVersion: 0,
          connectionId: "connection",
        });
        const sql = (yield* RelayDb).$client;
        const stamp = yield* clock;
        const expiredAt = Store.iso(Date.parse(yield* Fence.timestamp) - 1);
        yield* sql`UPDATE relay_workflow_authorizations SET expires_at=${expiredAt}`;
        expect((yield* receive(revocation(stamp))).status).toBe(200);
        expect((yield* Store.attempt("org", "native-app"))?.expected_epoch).toBe(1);
        expect(
          yield* Sources.callback(
            new URL(pending.authorization!.url).searchParams.get("state")!,
            "code",
          ).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" });
      }),
    ),
  );

  it.live("serializes a concurrent Begin before forwarding the later reconnect", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const attemptingRevocation = yield* Deferred.make<void>();
        const begin = yield* Sources.begin("org", "admin", {
          attemptId: "concurrent",
          expectedVersion: 0,
          connectionId: "connection",
        }).pipe(
          Effect.provideService(CurrentTransformer, (statement) =>
            Effect.gen(function* () {
              if (statement.compile()[0].includes("SET started_at=NULL")) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return statement;
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        const revokedAt = (yield* clock) - 1;
        const revoking = yield* receive(revocation(revokedAt)).pipe(
          Effect.provideService(CurrentTransformer, (statement) =>
            Effect.gen(function* () {
              const query = statement.compile()[0];
              if (
                query.includes("FROM relay_workflow_authorizations") &&
                query.includes("FOR UPDATE")
              )
                yield* Deferred.succeed(attemptingRevocation, undefined);
              return statement;
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(attemptingRevocation);
        yield* Deferred.succeed(release, undefined);
        const pending = yield* Fiber.join(begin);
        expect((yield* Fiber.join(revoking)).status).toBe(200);
        expect((yield* Store.attempt("org", "native-app"))?.expected_epoch).toBe(2);
        expect(
          yield* Sources.callback(
            new URL(pending.authorization!.url).searchParams.get("state")!,
            "code",
          ),
        ).toBe("connection");
      }),
    ),
  );

  it.live("keeps unrelated epoch changes and a newer retained cutoff fenced", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const sql = (yield* RelayDb).$client;
        const pending = yield* Sources.begin("org", "admin", {
          attemptId: "stale-epoch",
          expectedVersion: 0,
          connectionId: "connection",
        });
        // A different authority mutation cannot inherit the exception for provider revocation.
        yield* sql`UPDATE relay_workflow_connections SET authorization_epoch=authorization_epoch+1 WHERE connection_id='connection'`;
        expect((yield* receive(revocation((yield* clock) - 1000))).status).toBe(200);
        expect((yield* Store.attempt("org", "native-app"))?.expected_epoch).toBe(1);
        expect(
          yield* Sources.callback(
            new URL(pending.authorization!.url).searchParams.get("state")!,
            "code",
          ).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" });
        const owner = yield* Sources.owner("org", "admin");
        const next = yield* Sources.begin("org", "admin", {
          attemptId: "stale-time",
          expectedVersion: owner.version,
          connectionId: "connection",
        });
        const gate = yield* gateExchange(
          new URL(next.authorization!.url).searchParams.get("state")!,
        );
        const callback = yield* gate.callback.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(gate.entered);
        const nextAttempt = (yield* Store.attempt("org", "native-app"))!;
        const boundary = Date.parse(nextAttempt.started_at!);
        expect((yield* receive(revocation(boundary + 1))).status).toBe(200);
        expect((yield* receive(revocation(boundary - 1))).status).toBe(200);
        yield* Deferred.succeed(gate.release, undefined);
        expect(yield* Fiber.join(callback)).toMatchObject({ code: "conflict" });
      }),
    ),
  );
});
