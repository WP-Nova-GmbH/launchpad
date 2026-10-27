import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { RepositoryWorkflow, WorkflowTrigger } from "@t3tools/contracts/workflows";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import { receiveWorkflowEvent } from "../http/WorkflowEventsRoute.ts";
import { config, createConnection } from "../workflowSources/test-fixture.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Workflows from "../jobs/Workflows.ts";
import * as Routing from "./Routing.ts";
export const webhookConfig = {
  ...config,
  linearWorkflowWebhook: {
    applicationId: "native-app",
    signingSecret: Redacted.make("webhook-test-secret"),
    generation: "coverage-1",
    admissionEnabled: true,
  },
};
export const configured = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.provideService(RelayConfiguration, webhookConfig),
    Effect.provide(NodeCrypto.layer),
  );
export const trigger: WorkflowTrigger = {
  provider: "linear",
  connectionId: "connection",
  grantId: "grant",
  teamId: "team",
  labelIds: [],
  event: "issue_created",
};
export const definition: RepositoryWorkflow["definition"] = {
  name: "Implement",
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  steps: [
    {
      kind: "agent",
      id: "agent",
      title: "Agent",
      instruction: "Implement the issue.",
      modelSelection: null,
    },
  ],
};
export const clock = DateTime.now.pipe(Effect.map((d) => d.epochMilliseconds));
// Synthetic fixtures based on the official generated IssueWebhookPayload/EntityWebhookPayload,
// not captures of a live subscription: https://github.com/linear/linear/blob/9dd2ed80f93ae596f4f7fa21aa7cf80895c58514/packages/sdk/src/_generated_documents.ts
export const issue = (time: number, extra: Record<string, unknown> = {}) => ({
  type: "Issue",
  action: "create",
  organizationId: "workspace",
  createdAt: Store.iso(time),
  webhookTimestamp: time,
  webhookId: "subscription-1",
  data: {
    id: "issue",
    teamId: "team",
    stateId: "ready",
    labelIds: [],
    updatedAt: Store.iso(time),
    identifier: "ENG-1",
    title: "Implement feature",
    url: "https://linear.app/test/issue/ENG-1",
  },
  ...extra,
});
export const revocation = (time: number) => ({
  type: "OAuthApp",
  action: "revoked",
  oauthClientId: "native-app",
  organizationId: "workspace",
  createdAt: Store.iso(time),
  webhookTimestamp: time,
  webhookId: "subscription-1",
});
export const sign = (body: string) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("webhook-test-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return Array.from(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  });
export const receive = Effect.fn(function* (
  payload: unknown,
  headers: Record<string, string> = {},
) {
  const body = Store.json(payload);
  const signature = yield* sign(body);
  return yield* receiveWorkflowEvent.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("https://relay.test/webhooks/workflow-sources/linear", {
          method: "POST",
          body,
          headers: { "linear-signature": signature, ...headers },
        }),
      ),
    ),
  );
});
export const seed = Effect.gen(function* () {
  const sql = (yield* RelayDb).$client;
  yield* createConnection();
  yield* Store.allow(
    "repo",
    "owner",
    { grantId: "grant", connectionId: "connection", previousGrantId: null },
    "native-app",
  );
  const past = Store.iso((yield* clock) - 10000);
  yield* sql`UPDATE relay_workflow_connections SET activated_at=${past},authorization_started_at=${past},delivery_evidence=${sql.json({ generation: "coverage-1", epoch: 1, teams: { team: { created: true, entered: true } } })}`;
  yield* sql`UPDATE relay_workflow_repository_grants SET created_at=${past}`;
  yield* sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES ('github.com/example/repository','repo','org',${past})`;
  yield* sql`INSERT INTO relay_machines(machine_id,organization_id,role,label,compute_kind,seed_hash,seed_expires_at,environment_id,environment_public_key,created_by_user_id,enrolled_at,created_at,updated_at) VALUES ('machine','org','agent_executor','Executor','docker','seed','2027','environment','public','owner',${past},${past},${past})`;
  yield* sql`INSERT INTO relay_organization_project_catalogs VALUES ('environment','org','machine',1,${past},${past})`;
  yield* sql`INSERT INTO relay_organization_projects VALUES ('environment','project','org','machine','Repository','github.com/example/repository',${past},${past},${past})`;
});
export const save = Effect.fn(function* (
  id = "flow",
  selected = trigger,
  enabled = true,
  name = "Implement",
) {
  const store = yield* Workflows.make;
  const previous = yield* store.get(id);
  const c = (yield* Store.connection(selected.connectionId))!;
  const proof = {
    epoch: c.authorization_epoch,
    connectionId: c.connection_id,
    generation: "coverage-1",
    triggerKey: Routing.triggerKey(Routing.automation({ enabled, trigger: selected }).trigger),
    targetKey: Routing.targetKey(definition),
    canonicalKey: "github.com/example/repository",
  };
  return yield* store.save(
    "org",
    "repo",
    {
      workflowId: id,
      expectedRevision: previous?.revision ?? 0,
      definition: { ...definition, name },
      archived: false,
      automation: { enabled, trigger: selected },
    },
    { userId: "maintainer", proof },
  );
});
export const enableBeforeEvent = Effect.fn(function* (id = "flow", selected = trigger) {
  const saved = yield* save(id, selected);
  const sql = (yield* RelayDb).$client;
  yield* sql`UPDATE relay_repository_workflows SET effective_after=${Store.iso((yield* clock) - 5000)} WHERE workflow_id=${id}`;
  return saved;
});
export const counts = Effect.gen(function* () {
  const sql = (yield* RelayDb).$client;
  return (yield* sql<{
    occurrences: number;
    jobs: number;
    admissions: number;
  }>`SELECT (SELECT count(*)::int FROM relay_workflow_occurrences) AS occurrences,(SELECT count(*)::int FROM relay_workflow_jobs) AS jobs,(SELECT count(*)::int FROM relay_workflow_admissions) AS admissions`)[0]!;
});
