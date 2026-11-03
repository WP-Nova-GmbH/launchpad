import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import * as schema from "./schema.ts";
import {
  normalizeStoredWorkflow,
  normalizeStoredWorkflowJob,
} from "@t3tools/shared/workflowStorage";

const url = process.env.WORKFLOW_SOURCES_TEST_DATABASE_URL;
const migrationsDir = new URL("../../migrations/postgres/", import.meta.url).pathname;
const commonHead = "32fe6e1e-3ff0-4c72-bfb6-c7f633904c61";
const workflowHead = "c88a4021-99f3-4339-b003-118b2ac1c050";
const vmHead = "d42d70fa-bc6e-4f9a-93db-956ca63fa8e3";
const codexVmHead = "dab2362b-4578-42d4-a278-a4ee43d1214e";
const stockVmHead = "c57df92d-b498-403e-9d19-d8453f1502dd";
const runtimeMigration = "20261028221922_thread_vm_runtime_protocol";
const foundationMigration = "20261102170843_workflow_execution_foundation";
const prefix = "workflow_vm_merge_20261027_";
type Snapshot = Awaited<ReturnType<typeof generateDrizzleJson>>;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

// The supplied test DSN is administrative only; all schema/data writes go to
// fresh child databases, which are dropped after their connections close.
const withDatabase = <A, E, R>(
  label: string,
  use: (
    sql: PgClient.PgClient,
    db: Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const admin = yield* PgClient.PgClient;
    const name = prefix + label + "_" + NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const target = new URL(url!);
    target.pathname = "/" + name;
    return yield* Effect.acquireUseRelease(
      admin.unsafe(`CREATE DATABASE "${name}"`),
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const db = yield* PgDrizzle.makeWithDefaults();
          return yield* use(sql, db);
        }).pipe(
          Effect.provide(
            PgClient.layer({ url: Redacted.make(target.toString()), maxConnections: 1 }),
          ),
          Effect.scoped,
        ),
      () => admin.unsafe(`DROP DATABASE "${name}"`).pipe(Effect.orDie),
    );
  });

// Compare server-normalized definitions rather than snapshot JSON alone. Column
// order is irrelevant; default/generated expressions and constraint names are not.
const catalog = (sql: PgClient.PgClient) =>
  Effect.all({
    columns: sql`SELECT c.relname AS relation,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS not_null,a.attidentity::text AS identity,a.attgenerated::text AS generated,
      pg_get_expr(d.adbin,d.adrelid) AS expression,c.relrowsecurity AS row_security
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname,a.attname`,
    constraints: sql`SELECT c.relname AS relation,k.conname AS name,k.contype::text AS type,
      k.convalidated AS validated,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname,k.conname`,
    indexes: sql`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
    views: sql`SELECT viewname,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname`,
    sequences: sql`SELECT sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size
      FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`,
    functions: sql`SELECT p.proname AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname`,
    triggers: sql`SELECT c.relname AS relation,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    policies: sql`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
      WHERE schemaname='public' ORDER BY tablename,policyname`,
  });

const ledger = (sql: PgClient.PgClient) =>
  sql<{
    id: number;
    name: string;
    hash: string;
    created_at: string;
  }>`SELECT id,name,hash,created_at FROM drizzle.relay_migrations ORDER BY id`;

const seed = (sql: PgClient.PgClient, names: ReadonlySet<string>) =>
  Effect.gen(function* () {
    if (!names.size) return;
    yield* sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES ('merge-org','Merge','2026','2026')`;
    yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES ('merge-org','merge-user','admin','2026','2026')`;
    yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES ('merge-repo','merge-org','Repository','2026','2026')`;
    if (names.has("20261019163246_workflow_automatic_starts")) {
      const definition = {
        name: "Preserved workflow",
        environmentId: "environment",
        projectId: "project",
        steps: [
          {
            id: "agent",
            kind: "agent",
            title: "Implement",
            instruction: "Implement",
            modelSelection: null,
          },
        ],
      };
      const flow = {
        workflowId: "merge-flow",
        organizationId: "merge-org",
        repositoryId: "merge-repo",
        revision: 1,
        definition,
        archived: false,
        automation: { enabled: false, trigger: null },
        createdAt: "2026",
        updatedAt: "2026",
      };
      yield* sql`INSERT INTO relay_repository_workflows(workflow_id,repository_id,revision,record) VALUES ('merge-flow','merge-repo',1,${sql.json(flow)})`;
      const record = {
        jobId: "merge-job",
        repositoryId: "merge-repo",
        workflowId: "merge-flow",
        environmentId: "environment",
        instruction: "Preserved task",
        origin: { kind: "manual", userId: "merge-user" },
        status: "queued",
        workflow: null,
        progress: null,
        detail: null,
        createdAt: "2026",
        updatedAt: "2026",
      };
      yield* sql`INSERT INTO relay_workflow_jobs(job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at) VALUES ('merge-job','merge-repo','merge-org','merge-user','queued',${sql.json(record)},0,'2026','2026')`;
      const accepted = {
        ...record,
        jobId: "merge-accepted-job",
        status: "dispatching",
        workflow: flow,
        requiredProtocol: 8,
        startAttempted: true,
      };
      yield* sql`INSERT INTO relay_workflow_jobs(job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at) VALUES ('merge-accepted-job','merge-repo','merge-org','merge-user','dispatching',${sql.json(accepted)},0,'2026','2026')`;
      const { startAttempted: _attempted, ...uncertain } = {
        ...accepted,
        jobId: "merge-uncertain-job",
      };
      yield* sql`INSERT INTO relay_workflow_jobs(job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at) VALUES ('merge-uncertain-job','merge-repo','merge-org','merge-user','dispatching',${sql.json(uncertain)},0,'2026','2026')`;
      yield* sql`INSERT INTO relay_workflow_connections(connection_id,owner_user_id,application_id,workspace_id,workspace_name,viewer_name,status,activated_at,payload_sealed,health) VALUES ('merge-connection','merge-user','app','workspace','Workspace','Owner','connected','2026','sealed-fixture','{"code":"healthy","retryAt":null}')`;
      yield* sql`INSERT INTO relay_workflow_repository_grants(grant_id,connection_id,organization_id,repository_id,owner_user_id,generation,created_at) VALUES ('merge-grant','merge-connection','merge-org','merge-repo','merge-user',1,'2026')`;
    }
    if (names.has("20261023131714_thread_original_location")) {
      yield* sql`INSERT INTO relay_thread_placements(thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id,original_environment_id,original_project_id) VALUES ('merge-thread','merge-org','merge-repo','merge-user','environment','project','original-environment','original-project')`;
      yield* sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,compute_ref,state) VALUES ('merge-allocation','merge-thread','merge-org','merge-user','template','compute','running')`;
      yield* sql`INSERT INTO relay_thread_history(thread_id,cursor,environment_id,source_sequence,event_json) VALUES ('merge-thread',1,'environment',1,'{"type":"thread.created","payload":{"projectId":"project"}}')`;
      yield* sql`INSERT INTO relay_thread_current_queues(thread_id,cursor,queue_json) VALUES ('merge-thread',1,'{"entries":[]}')`;
      if (names.has(runtimeMigration))
        yield* sql`UPDATE relay_thread_vm_allocations SET sealed_traffic_access_token='preserved-sealed-ingress' WHERE allocation_id='merge-allocation'`;
    }
    if (names.has("20261028130056_codex_vm_connections")) {
      yield* sql`INSERT INTO relay_codex_vm_installation(key,host_id) VALUES ('installation','preserved-host')`;
      yield* sql`INSERT INTO relay_codex_vm_connections(organization_id,connection_id,epoch,token_revision,action_revision,issuer,subject,client_id,label,status,payload_sealed,expires_at,updated_at)
        VALUES ('merge-org','preserved-codex-connection',2,3,4,'https://auth.openai.com','preserved-subject','preserved-client','Preserved account','connected','sealed-codex-fixture','2099','2026')`;
      yield* sql`INSERT INTO relay_thread_vm_codex_auth(allocation_id,environment_id,generation,thread_id,organization_id,mode,connection_id,acknowledged_connection_id)
        VALUES ('merge-allocation','environment',1,'merge-thread','merge-org','organization','preserved-codex-connection','preserved-codex-connection')`;
    }
    if (names.has("20261102155030_thread_vm_codex_preferences"))
      yield* sql`INSERT INTO relay_thread_vm_codex_preferences(thread_id,organization_id,revision,mode,connection_id)
        VALUES('merge-thread','merge-org',7,'organization','preserved-codex-connection')`;
  });

const records = (sql: PgClient.PgClient, omitNativeAllocationColumns = false) =>
  Effect.gen(function* () {
    const tables = yield* sql<{
      name: string;
    }>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
    const values: Record<string, unknown> = {};
    for (const { name } of tables) {
      const omitted =
        name === "relay_thread_placements"
          ? "-'audience'-'workflow_job_id'"
          : name === "relay_thread_vm_allocations"
            ? "-'resource_kind'"
            : name === "relay_thread_vm_policies"
              ? "-'workflow_policy_revision'-'max_running_workflow_vms'"
              : name === "relay_workflow_jobs"
                ? "-'summary'"
                : "";
      const rows = yield* sql.unsafe<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(t)${omitted}${omitNativeAllocationColumns && name === "relay_thread_vm_allocations" ? "-'runtime_protocol'-'sealed_traffic_access_token'" : ""} AS row FROM "${name}" t ORDER BY to_jsonb(t)::text`,
      );
      if (rows.length)
        values[name] = rows.map(({ row }) => ({
          row: {
            ...row,
            ...(name === "relay_repository_workflows"
              ? { record: normalizeStoredWorkflow(row.record) }
              : {}),
            ...(name === "relay_workflow_jobs"
              ? { record: normalizeStoredWorkflowJob(row.record) }
              : {}),
          },
        }));
    }
    return values;
  });

describe.skipIf(!url)("workflow and VM PostgreSQL migration convergence", () => {
  it.live(
    "upgrades empty, common, workflow, VM, Codex and stock databases without losing data or replaying migrations",
    () =>
      Effect.gen(function* () {
        const adminUrl = new URL(url!);
        if (!adminUrl.pathname.startsWith("/" + prefix))
          throw new Error("Use a disposable workflow_vm_merge_20261027_* database.");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dirs = (yield* fs.readDirectory(migrationsDir)).sort();
        const entries = yield* Effect.forEach(dirs, (name) =>
          Effect.gen(function* () {
            return {
              name,
              snapshot: (yield* decodeJson(
                yield* fs.readFileString(path.join(migrationsDir, name, "snapshot.json")),
              )) as Snapshot,
              sql: yield* fs.readFileString(path.join(migrationsDir, name, "migration.sql")),
            };
          }),
        );
        const byId = new Map(entries.map((entry) => [entry.snapshot.id, entry]));
        const ancestors = (id: string, names = new Set<string>()): Set<string> => {
          const entry = byId.get(id);
          if (!entry || names.has(entry.name)) return names;
          names.add(entry.name);
          for (const parent of entry.snapshot.prevIds) ancestors(parent, names);
          return names;
        };
        const common = ancestors(commonHead);
        const workflows = ancestors(workflowHead);
        const vms = new Set([...ancestors(vmHead), ...common]);
        const codex = ancestors(codexVmHead);
        const stock = ancestors(stockVmHead);
        const foundation = entries.find((entry) => entry.name === foundationMigration);
        expect(foundation).toBeDefined();
        const current = new Set(foundation!.snapshot.prevIds.flatMap((id) => [...ancestors(id)]));
        expect([common.size, workflows.size, vms.size]).toEqual([27, 33, 98]);
        const parents = new Set(entries.flatMap((entry) => entry.snapshot.prevIds));
        const leaves = entries.filter((entry) => !parents.has(entry.snapshot.id));
        expect(leaves).toHaveLength(1);
        const head = leaves[0]!.snapshot;
        expect(ancestors(head.id).size).toBe(entries.length);
        const generated = yield* Effect.promise(() => generateDrizzleJson(schema));
        expect(yield* Effect.promise(() => generateMigration(head, generated))).toEqual([]);
        const empty = yield* Effect.promise(() => generateDrizzleJson({}));
        const expectedDdl = yield* Effect.promise(() => generateMigration(empty, generated));
        const customSql = entries
          .flatMap((entry) => entry.sql.split("--> statement-breakpoint"))
          .filter((statement) =>
            /^(CREATE(?: OR REPLACE)? (?:FUNCTION|TRIGGER)|DROP (?:FUNCTION|TRIGGER))\b/i.test(
              statement.replace(/^(?:\s*--[^\n]*(?:\n|$))*/, "").trim(),
            ),
          );
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-vm-migrations-" });
        const expected = yield* withDatabase("expected", (sql) =>
          Effect.gen(function* () {
            for (const statement of [...expectedDdl, ...customSql]) yield* sql.unsafe(statement);
            return yield* catalog(sql);
          }),
        );
        for (const [label, baseline] of [
          ["empty", new Set<string>()],
          ["common", common],
          ["workflows", workflows],
          ["vms", vms],
          ["codex", codex],
          ["stock", stock],
          ["current", current],
        ] as const) {
          const baselineFolder = path.join(folder, label);
          yield* fs.makeDirectory(baselineFolder);
          for (const entry of entries.filter((entry) => baseline.has(entry.name))) {
            yield* fs.makeDirectory(path.join(baselineFolder, entry.name));
            yield* fs.writeFileString(
              path.join(baselineFolder, entry.name, "migration.sql"),
              entry.sql,
            );
          }
          yield* withDatabase(label, (sql, db) =>
            Effect.gen(function* () {
              if (baseline.size)
                yield* migrate(db, {
                  migrationsFolder: baselineFolder,
                  migrationsTable: "relay_migrations",
                });
              const beforeLedger = baseline.size ? yield* ledger(sql) : [];
              yield* seed(sql, baseline);
              const omitNativeAllocationColumns = !baseline.has(runtimeMigration);
              const before = yield* records(sql, omitNativeAllocationColumns);
              yield* migrate(db, {
                migrationsFolder: migrationsDir,
                migrationsTable: "relay_migrations",
              });
              const after = yield* records(sql, omitNativeAllocationColumns);
              if (baseline.has("20261023131714_thread_original_location")) {
                const [allocation] = yield* sql<{
                  protocol: string;
                  ingress: string | null;
                }>`SELECT runtime_protocol AS protocol,sealed_traffic_access_token AS ingress FROM relay_thread_vm_allocations WHERE allocation_id='merge-allocation'`;
                expect(allocation, label).toEqual({
                  protocol: omitNativeAllocationColumns ? "legacy" : "native-v1",
                  ingress: omitNativeAllocationColumns ? null : "preserved-sealed-ingress",
                });
                const [ownership] = yield* sql`SELECT t.audience,t.workflow_job_id,a.resource_kind
                  FROM relay_thread_placements t JOIN relay_thread_vm_allocations a USING(thread_id)
                  WHERE t.thread_id='merge-thread'`;
                expect(ownership).toEqual({
                  audience: "private",
                  workflow_job_id: null,
                  resource_kind: "personal",
                });
              }
              if (baseline.has("20261019163246_workflow_automatic_starts")) {
                const [saved] = yield* sql<{
                  record: Record<string, unknown>;
                }>`SELECT record FROM relay_repository_workflows WHERE workflow_id='merge-flow'`;
                expect(saved!.record).toMatchObject({
                  revision: 1,
                  definition: {
                    target: { kind: "machine", environmentId: "environment", projectId: "project" },
                  },
                });
                expect(saved!.record.definition).not.toHaveProperty("environmentId");
                const jobs = yield* sql<{
                  jobId: string;
                  record: Record<string, unknown>;
                  summary: Record<string, unknown>;
                }>`SELECT job_id AS "jobId",record,summary FROM relay_workflow_jobs ORDER BY job_id`;
                for (const job of jobs) {
                  expect(job.record).not.toHaveProperty("environmentId");
                  expect(job.summary.runtime).toEqual(job.record.runtime);
                  if (job.jobId === "merge-job") {
                    expect(job.record).toMatchObject({ workflow: null, runtime: null });
                  } else {
                    expect(job.record).toMatchObject({
                      requiredProtocol: 8,
                      runtime: {
                        kind: "machine",
                        environmentId: "environment",
                        projectId: "project",
                      },
                    });
                    expect(job.record.workflow).toEqual(saved!.record);
                  }
                  if (job.jobId === "merge-accepted-job")
                    expect(job.record.startAttempted).toBe(true);
                  if (job.jobId === "merge-uncertain-job")
                    expect(job.record).not.toHaveProperty("startAttempted");
                }
              }
              for (const [table, rows] of Object.entries(before))
                expect(after[table], label + ": " + table).toEqual(rows);
              expect(yield* catalog(sql), label + ": database schema").toEqual(expected);
              const applied = yield* ledger(sql);
              expect(applied.filter((entry) => baseline.has(entry.name))).toEqual(beforeLedger);
              expect(applied.map((entry) => entry.name).sort()).toEqual(dirs);
              for (const entry of entries)
                expect(applied.find((row) => row.name === entry.name)?.hash).toBe(
                  NodeCrypto.createHash("sha256").update(entry.sql).digest("hex"),
                );
              yield* migrate(db, {
                migrationsFolder: migrationsDir,
                migrationsTable: "relay_migrations",
              });
              expect(yield* ledger(sql)).toEqual(applied);
              expect(yield* records(sql, omitNativeAllocationColumns)).toEqual(after);
              expect(yield* catalog(sql)).toEqual(expected);
            }),
          );
        }
      }).pipe(
        Effect.provide([
          PgClient.layer({ url: Redacted.make(url ?? ""), maxConnections: 1 }),
          NodeServices.layer,
        ]),
        Effect.scoped,
      ),
    120_000,
  );
});
