import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { layer as RunnerLayer } from "../processRunner.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderAdapterProbeError } from "../provider/Errors.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { prepareThreadTransfer } from "./ThreadTransferReadiness.ts";
import { workspaceGit } from "./ThreadWorkspaceGit.ts";

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-10-05T10:00:00.000Z";
let serial = 0;
const fixture = Effect.fnUntraced(function* (options?: {
  script?: string;
  native?: boolean;
  wrongIdentity?: boolean;
  authenticated?: boolean;
  installed?: boolean;
  version?: string;
  liveSession?: boolean;
  resumeFailure?: string;
  cleanupConfirmed?: boolean;
  probe?: Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    sql = yield* SqlClient.SqlClient;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "transfer-ready-" }));
  yield* workspaceGit(root, ["init", "-b", "main"]);
  const threadId = ThreadId.make(`ready-${++serial}`),
    operationId = `move-${threadId}`,
    projectId = `project-${threadId}`;
  const instanceId = ProviderInstanceId.make("codex"),
    driverKind = ProviderDriverKind.make("codex");
  const model = { instanceId, model: "gpt-5" };
  const cursor = {
    threadId: "00000000-0000-4000-8000-000000000001",
    resumePolicy: "require-existing",
    portableStateId: "a".repeat(64),
  };
  const native =
    options?.native === false ? "null" : encode({ ...cursor, providerInstanceId: instanceId });
  const input = { threadId, operationId, generation: 2, manifestSha256: "b".repeat(64) };
  yield* fs.writeFileString(
    path.join(root, "t3.json"),
    encode({
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: options?.script ?? "printf 'setup\\n' >> setup-count",
          runOnWorktreeCreate: true,
        },
      ],
    }),
  );
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Test', ${root}, '[]', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Test', ${encode(model)}, 'full-access', 'default', 'main', ${at}, ${at})`;
  const fence = makeThreadExecutionFence(sql);
  yield* fence.prepare({
    ...input,
    projectId,
    environmentId: "destination",
    relayUrl: "https://relay.example",
  });
  yield* sql`INSERT INTO thread_checkout_claims (operation_id, thread_id, generation, project_id, repository_root, checkout_path,
    mode, branch, manifest_sha256, workspace_sha256, inspection_json, phase)
    VALUES (${operationId}, ${threadId}, 2, ${projectId}, ${root}, ${root}, 'main', 'main', ${input.manifestSha256}, ${"c".repeat(64)}, '{}', 'installed')`;
  yield* sql`INSERT INTO thread_transfer_baselines (operation_id, thread_id, generation, manifest_sha256, history_sha256, receipts_sha256,
    source_environment_id, source_sequence, destination_sequence, native_runtime_json)
    VALUES (${operationId}, ${threadId}, 2, ${input.manifestSha256}, ${"d".repeat(64)}, ${"e".repeat(64)}, 'source', 1, 1, ${native})`;
  if (options?.native !== false)
    yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json)
      VALUES (${threadId}, 'codex', ${instanceId}, 'codex', 'full-access', 'stopped', ${at}, ${encode(cursor)}, NULL)`;
  const calls: string[] = [];
  let status: ServerProvider = {
    instanceId,
    driver: driverKind,
    enabled: true,
    installed: options?.installed ?? true,
    version: options?.version ?? "0.159.3",
    status: "ready",
    auth: { status: options?.authenticated === false ? "unauthenticated" : "authenticated" },
    checkedAt: at,
    models: [],
    slashCommands: [],
    skills: [],
  };
  let resumeFailure = options?.resumeFailure;
  const unused = () => Effect.die("Unexpected provider operation during readiness");
  const instance: ProviderInstance = {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: "test" },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.sync(() => status),
      refresh: Effect.sync(() => {
        calls.push("credentials");
        return status;
      }),
      resolveMaintenance: unused,
      streamChanges: Stream.empty,
      applyUsageLimits: unused,
    },
    textGeneration: {
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateBranchName: unused,
      generateThreadTitle: unused,
      generateApprovalVerdict: unused,
    },
    adapter: {
      provider: driverKind,
      capabilities: { sessionModelSwitch: "in-session" },
      hasSession: () => Effect.succeed(options?.liveSession ?? false),
      startSession: unused,
      probeSession: (request) =>
        Effect.gen(function* () {
          expect(request.cwd).toBe(root);
          expect(request.resumeCursor).toEqual(cursor);
          expect(yield* fs.readFileString(path.join(root, "setup-count")).pipe(Effect.orDie)).toBe(
            "setup\n",
          );
          calls.push("resume");
          if (options?.probe) yield* options.probe;
          calls.push("stop");
          if (resumeFailure)
            return yield* new ProviderAdapterProbeError({
              provider: "codex",
              threadId,
              detail: resumeFailure,
              cleanupConfirmed: options?.cleanupConfirmed ?? false,
            });
          return {
            provider: driverKind,
            threadId,
            status: "ready" as const,
            runtimeMode: request.runtimeMode,
            cwd: root,
            resumeCursor: options?.wrongIdentity ? { ...cursor, threadId: "different" } : cursor,
            createdAt: at,
            updatedAt: at,
          };
        }),
      stopSession: () =>
        Effect.sync(() => {
          calls.push("stop");
        }),
      sendTurn: unused,
      interruptTurn: unused,
      respondToRequest: unused,
      respondToUserInput: unused,
      listSessions: unused,
      readThread: unused,
      rollbackThread: unused,
      stopAll: unused,
      streamEvents: Stream.empty,
    },
  };
  const prepare = prepareThreadTransfer(input).pipe(
    Effect.provide(
      Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
    ),
  );
  const phase = sql<{
    phase: string;
  }>`SELECT phase FROM thread_transfer_readiness WHERE operation_id = ${operationId}`;
  return {
    input,
    prepare,
    phase,
    fence,
    calls,
    sql,
    fs,
    path,
    root,
    authenticate: () => {
      status = { ...status, auth: { status: "authenticated" } };
    },
    changeRuntime: (version: string, failure?: string) => {
      status = { ...status, version };
      resumeFailure = failure;
    },
  };
});
it.layer(
  Layer.mergeAll(SqlitePersistenceMemory, RunnerLayer.pipe(Layer.provideMerge(NodeServices.layer))),
)("destination transfer readiness", (it) => {
  it.effect("rejects workflow ownership before destination setup or native validation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.sql`INSERT INTO repository_workflow_jobs VALUES ('held',${f.input.threadId},'awaiting_review',0,'{}')`;
      expect((yield* Effect.flip(f.prepare)).message).toContain("workflow");
      expect(yield* f.fs.exists(f.path.join(f.root, "setup-count"))).toBe(false);
      expect(f.calls).toEqual([]);
      expect(yield* f.phase).toEqual([]);
    }),
  );

  it.effect(
    "runs setup once, resumes only the native conversation, closes it and stays fenced until activation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.flip(f.fence.activate(f.input));
        yield* f.prepare;
        expect(f.calls).toEqual(["credentials", "resume", "stop"]);
        expect(yield* f.phase).toEqual([{ phase: "ready" }]);
        expect((yield* f.fence.get(f.input.threadId))?.phase).toBe("frozen");
        yield* f.sql`CREATE TEMP TRIGGER keep_setup_receipt BEFORE UPDATE OF setup_output_json,setup_started,setup_succeeded ON thread_transfer_readiness
          BEGIN SELECT RAISE(ABORT, 'setup receipt must not be rewritten'); END`;
        yield* f.prepare;
        expect(f.calls).toEqual(["credentials", "resume", "stop", "credentials", "resume", "stop"]);
        expect(yield* f.fs.readFileString(f.path.join(f.root, "setup-count"))).toBe("setup\n");
        yield* f.sql`DROP TRIGGER keep_setup_receipt`;
        yield* f.fence.activate(f.input);
        expect((yield* f.fence.get(f.input.threadId))?.phase).toBe("active");
      }),
  );
  it.effect(
    "can retry missing credentials without replaying setup or inventing another conversation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ authenticated: false });
        expect((yield* Effect.flip(f.prepare)).message).toContain("configured sign-in");
        expect(yield* f.phase).toEqual([]);
        expect((yield* f.fence.get(f.input.threadId))?.phase).toBe("frozen");
        expect(yield* f.fs.exists(f.path.join(f.root, "setup-count"))).toBe(false);
        f.authenticate();
        yield* f.prepare;
        expect(f.calls).toEqual(["credentials", "credentials", "resume", "stop"]);
        yield* f.prepare;
        expect(f.calls).toEqual([
          "credentials",
          "credentials",
          "resume",
          "stop",
          "credentials",
          "resume",
          "stop",
        ]);
        expect(yield* f.fs.readFileString(f.path.join(f.root, "setup-count"))).toBe("setup\n");
      }),
  );
  it.effect("keeps failed setup frozen and never automatically replays its script", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ script: "printf 'attempt\\n' >> setup-count; exit 7" });
      expect((yield* Effect.flip(f.prepare)).message).toContain("setup failed");
      expect((yield* Effect.flip(f.prepare)).message).toContain("do not replay");
      expect(f.calls).toEqual(["credentials", "credentials"]);
      expect(yield* f.fs.readFileString(f.path.join(f.root, "setup-count"))).toBe("attempt\n");
      expect(yield* f.phase).toEqual([{ phase: "started" }]);
      yield* Effect.flip(f.fence.activate(f.input));
    }),
  );
  it.effect("closes a mismatched native session and refuses readiness", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ wrongIdentity: true });
      expect((yield* Effect.flip(f.prepare)).message).toContain("transferred conversation");
      expect(f.calls).toEqual(["credentials", "resume", "stop"]);
      yield* Effect.flip(f.fence.activate(f.input));
    }),
  );
  for (const options of [{ authenticated: false }, { installed: false }, { liveSession: true }]) {
    it.effect(`blocks setup when prerequisites fail: ${encode(options)}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(options);
        expect((yield* Effect.flip(f.prepare)).message).toContain(
          "liveSession" in options ? "provider session is already" : "configured sign-in",
        );
        expect(yield* f.fs.exists(f.path.join(f.root, "setup-count"))).toBe(false);
        yield* Effect.flip(f.fence.activate(f.input));
      }),
    );
  }
  it.effect("accepts another Codex version when it resumes the transferred conversation", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ version: "0.163.0-alpha.10.2" });
      yield* f.prepare;
      expect(f.calls).toEqual(["credentials", "resume", "stop"]);
      expect(yield* f.phase).toEqual([{ phase: "ready" }]);
      expect((yield* f.fence.get(f.input.threadId))?.phase).toBe("frozen");
      yield* f.fence.activate(f.input);
      expect((yield* f.fence.get(f.input.threadId))?.phase).toBe("active");
    }),
  );
  it.effect("keeps a failed native resume fenced and preserves the Codex error", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        version: "0.163.0-alpha.10.2",
        resumeFailure: "This history contains an unsupported event type.",
      });
      const error = yield* Effect.flip(f.prepare);
      expect(error.message).toContain("Codex could not resume the transferred conversation");
      expect(error.message).toContain("This history contains an unsupported event type.");
      expect(f.calls).toEqual(["credentials", "resume", "stop"]);
      expect(yield* f.phase).toEqual([{ phase: "started" }]);
      expect((yield* f.fence.get(f.input.threadId))?.phase).toBe("frozen");
      yield* Effect.flip(f.fence.activate(f.input));
      expect((yield* Effect.flip(f.prepare)).message).toContain("no confirmed exit");
      expect(f.calls).toEqual(["credentials", "resume", "stop", "credentials"]);
    }),
  );
  it.effect("retries a positively stopped probe without replaying successful setup", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        resumeFailure: "Reconnect the organization account.",
        cleanupConfirmed: true,
      });
      expect((yield* Effect.flip(f.prepare)).message).toContain(
        "Reconnect the organization account",
      );
      expect(
        yield* f.sql`SELECT setup_succeeded,provider_probe_attempt_id FROM thread_transfer_readiness WHERE operation_id=${f.input.operationId}`,
      ).toEqual([{ setup_succeeded: 1, provider_probe_attempt_id: null }]);
      yield* Effect.flip(f.fence.activate(f.input));
      f.changeRuntime("0.159.3");
      yield* f.prepare;
      expect(yield* f.fs.readFileString(f.path.join(f.root, "setup-count"))).toBe("setup\n");
      expect(f.calls).toEqual(["credentials", "resume", "stop", "credentials", "resume", "stop"]);
      yield* f.fence.activate(f.input);
    }),
  );
  it.effect("invalidates old readiness after a safely stopped re-probe fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ cleanupConfirmed: true });
      yield* f.prepare;
      f.changeRuntime("0.159.3", "Account selection changed.");
      yield* Effect.flip(f.prepare);
      expect(yield* f.phase).toEqual([{ phase: "started" }]);
      yield* Effect.flip(f.fence.activate(f.input));
      f.changeRuntime("0.159.3");
      yield* f.prepare;
      yield* f.fence.activate(f.input);
      expect(yield* f.fs.readFileString(f.path.join(f.root, "setup-count"))).toBe("setup\n");
    }),
  );
  it.effect("holds one native probe owner until exact ready publication", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const f = yield* fixture({
        probe: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      const first = yield* f.prepare.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect((yield* Effect.flip(f.prepare)).message).toContain("no confirmed exit");
      yield* Effect.flip(f.fence.activate(f.input));
      expect(f.calls.filter((call) => call === "resume")).toHaveLength(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* f.fence.activate(f.input);
    }),
  );
  for (const kind of ["defect", "interruption"] as const)
    it.effect(`retains uncertain probe ownership after ${kind}`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const f = yield* fixture({
          probe: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(kind === "defect" ? Effect.die("probe crash") : Effect.never),
          ),
        });
        const pending = yield* f.prepare.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (kind === "interruption") yield* Fiber.interrupt(pending);
        const result = yield* Fiber.await(pending);
        expect(Exit.isFailure(result)).toBe(true);
        expect((yield* Effect.flip(f.prepare)).message).toContain("no confirmed exit");
        yield* Effect.flip(f.fence.activate(f.input));
        expect(yield* f.fs.readFileString(f.path.join(f.root, "setup-count"))).toBe("setup\n");
      }),
    );
  it.effect("rechecks native resume after a runtime update without replaying setup", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.prepare;
      f.changeRuntime("0.163.0-alpha.10.2", "This runtime cannot resume the transferred history.");
      const error = yield* Effect.flip(f.prepare);
      expect(error.message).toContain("This runtime cannot resume the transferred history.");
      expect(f.calls).toEqual(["credentials", "resume", "stop", "credentials", "resume", "stop"]);
      expect(yield* f.fs.readFileString(f.path.join(f.root, "setup-count"))).toBe("setup\n");
      expect((yield* f.fence.get(f.input.threadId))?.phase).toBe("frozen");
      expect(yield* f.phase).toEqual([{ phase: "started" }]);
      yield* Effect.flip(f.fence.activate(f.input));
    }),
  );
  it.effect(
    "checks credentials but does not invent native history for a never-started conversation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ native: false });
        yield* f.prepare;
        expect(f.calls).toEqual(["credentials"]);
        yield* f.fence.activate(f.input);
      }),
  );
  it.effect("refuses activation if the verified native cursor was replaced", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.prepare;
      yield* f.sql`UPDATE provider_session_runtime SET resume_cursor_json = '{}' WHERE thread_id = ${f.input.threadId}`;
      expect((yield* Effect.flip(f.fence.activate(f.input))).message).toContain("native runtime");
      yield* Effect.flip(f.prepare);
      expect((yield* f.fence.get(f.input.threadId))?.phase).toBe("frozen");
    }),
  );
  it.effect("retains a lost completion receipt without running setup again", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.sql`CREATE TEMP TRIGGER fail_ready BEFORE UPDATE OF phase ON thread_transfer_readiness
        WHEN NEW.phase = 'ready'
        BEGIN SELECT RAISE(ABORT, 'lost receipt'); END`;
      yield* Effect.flip(f.prepare);
      yield* f.sql`DROP TRIGGER fail_ready`;
      yield* f.prepare;
      expect(f.calls).toEqual(["credentials", "resume", "stop", "credentials", "resume", "stop"]);
      expect(yield* f.fs.readFileString(f.path.join(f.root, "setup-count"))).toBe("setup\n");
      yield* f.fence.activate(f.input);
    }),
  );
});
