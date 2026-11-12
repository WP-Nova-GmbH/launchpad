import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayThreadVmGitMetadata } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ServerSecretStore, SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";
import { ProcessRunner, layer as RunnerLayer } from "../processRunner.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import { THREAD_VM_INITIAL_STATE_SECRET } from "./ThreadVmInitialStateRecord.ts";
import { refreshInstalledThreadVmRepository } from "./ThreadVmGitRefresh.ts";
import {
  configureThreadVmRepository,
  readThreadVmRepositoryBinding,
  THREAD_VM_GIT_SETUP_SECRET,
} from "./ThreadVmRepositoryBinding.ts";
import { threadVmGitConfigHash } from "./ThreadVmGitConfig.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const environment = Layer.mergeAll(SqlitePersistenceMemory, RunnerLayer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const bot: RelayThreadVmGitMetadata = {
  status: "ready",
  appId: "12",
  appSlug: "launchpad",
  botUserId: 123,
  name: "launchpad[bot]",
  email: "123+launchpad[bot]@users.noreply.github.com",
};
const fixture = Effect.fnUntraced(function* (mode: "import" | "active" = "active", generation = 2) {
  const fs = yield* FileSystem.FileSystem,
    sql = yield* SqlClient.SqlClient,
    runner = yield* ProcessRunner,
    root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "vm-git-binding-" }));
  const owner = {
      operationId: "00000000-0000-4000-8000-000000000001",
      threadId: "thread",
      environmentId: "environment",
      relayUrl: "https://relay.test",
      generation,
    },
    scope = {
      allocationId: "allocation",
      threadId: "thread",
      repositoryId: "repository",
      generation,
    },
    vm = {
      ...owner,
      scope,
      relayIssuer: "https://issuer.test",
      environmentCredential: "credential",
      cloudMintPublicKey: "public-key",
    },
    canonicalKey = "github.com/acme/project";
  const records = new Map<string, Uint8Array>([
    [THREAD_VM_IDENTITY_SECRET, new TextEncoder().encode(encode(vm))],
  ]);
  let metadata: RelayThreadVmGitMetadata | undefined = bot,
    offline = false,
    failReceipt = false,
    calls = 0,
    beforeReply = Effect.void;
  const secrets = ServerSecretStore.of({
    get: (key) => Effect.sync(() => Option.fromNullishOr(records.get(key))),
    create: (key, value) =>
      Effect.sync(() => {
        records.set(key, value);
      }),
    set: (key, value) =>
      Effect.suspend(() =>
        failReceipt && key === THREAD_VM_GIT_SETUP_SECRET
          ? Effect.fail(
              new SecretStorePersistError({ resource: "setup receipt", cause: "interrupted" }),
            )
          : Effect.sync(() => {
              records.set(key, value);
            }),
      ),
    remove: (key) =>
      Effect.sync(() => {
        records.delete(key);
      }),
    getOrCreateRandom: () => Effect.die("unexpected random identity"),
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(owner.environmentId)),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            calls++;
            yield* beforeReply;
            return HttpClientResponse.fromWeb(
              request,
              offline
                ? new Response("offline", { status: 503 })
                : Response.json({
                    ...owner,
                    repositoryId: scope.repositoryId,
                    canonicalKey,
                    ...(metadata ? { git: metadata } : {}),
                  }),
            );
          }),
        ),
      ),
    );
  const git = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const result = yield* runner.run({
      command: "git",
      args,
      cwd: root,
      timeout: "10 seconds",
      maxOutputBytes: 16_384,
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" },
    });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trimEnd();
  });
  yield* git(["init", "--initial-branch=feature"]);
  const at = "2026-10-01T00:00:00Z";
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES('project','VM project',${root},'[]',${at},${at})`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,branch,created_at,updated_at)
    VALUES('thread','project','VM thread','{"instanceId":"codex","model":"model"}','feature',${at},${at})`;
  const fence = makeThreadExecutionFence(sql);
  yield* fence.prepare({ ...owner, projectId: "project" });
  if (mode === "active") yield* fence.activate(owner);
  else
    yield* sql`INSERT INTO thread_checkout_claims(operation_id,thread_id,generation,project_id,repository_root,checkout_path,mode,branch,manifest_sha256,workspace_sha256,inspection_json,phase)
    VALUES(${owner.operationId},'thread',${generation},'project',${root},${root},'main','feature',${"a".repeat(64)},${"b".repeat(64)},'{}','installed')`;
  return {
    fs,
    sql,
    root,
    owner,
    vm,
    scope,
    canonicalKey,
    records,
    fence,
    git,
    provide,
    configure: configureThreadVmRepository(owner, root, mode).pipe(provide),
    refresh: refreshInstalledThreadVmRepository.pipe(provide),
    setMetadata: (value: RelayThreadVmGitMetadata | undefined) => {
      metadata = value;
    },
    setOffline: () => {
      offline = true;
    },
    failReceipt: (value: boolean) => {
      failReceipt = value;
    },
    calls: () => calls,
    setBeforeReply: (effect: Effect.Effect<void>) => {
      beforeReply = effect;
    },
  };
});

describe("VM repository setup", () => {
  it.effect("upgrades a matching old setup receipt to install corrected branch defaults", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.configure;
        const remove = yield* (yield* ProcessRunner).run({
          command: "git",
          args: ["config", "--unset-all", "branch.autoSetupMerge"],
          cwd: f.root,
        });
        assert.include([0, 5], remove.code);
        const original = yield* f.fs.readFileString(`${f.root}/.git/config`),
          receipt = decodeRecord(
            new TextDecoder().decode(f.records.get(THREAD_VM_GIT_SETUP_SECRET)!),
          );
        f.records.set(
          THREAD_VM_GIT_SETUP_SECRET,
          new TextEncoder().encode(
            encode({ ...receipt, version: 1, configHash: threadVmGitConfigHash(original) }),
          ),
        );
        const resumed = { ...f.owner, operationId: "00000000-0000-4000-8000-000000000002" };
        yield* f.fence.beginDrain({ ...resumed, previousOperationId: f.owner.operationId });
        yield* f.fence.activate(resumed);
        assert.deepEqual(yield* f.refresh, { metadataPending: false });
        assert.equal(yield* f.git(["config", "branch.autoSetupMerge"]), "simple");
      }),
    ).pipe(Effect.provide(environment)),
  );

  for (const existingSetup of [false, true]) {
    it.effect(
      `refreshes after reopening ${existingSetup ? "with" : "without"} existing Git setup`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              identity = f.records.get(THREAD_VM_IDENTITY_SECRET);
            if (existingSetup) yield* f.configure;
            yield* f.fs.writeFileString(`${f.root}/staged.txt`, "staged\n");
            yield* f.git(["add", "staged.txt"]);
            yield* f.fs.writeFileString(`${f.root}/staged.txt`, "dirty\n");
            yield* f.fs.writeFileString(`${f.root}/untracked.txt`, "untracked\n");
            const status = yield* f.git(["status", "--porcelain=v1"]),
              config = yield* f.fs.readFileString(`${f.root}/.git/config`),
              receipt = f.records.get(THREAD_VM_GIT_SETUP_SECRET),
              resumed = { ...f.owner, operationId: "00000000-0000-4000-8000-000000000002" };
            yield* f.fence.beginDrain({ ...resumed, previousOperationId: f.owner.operationId });
            assert.isNull(yield* f.refresh);
            yield* f.fence.activate(resumed);
            assert.deepEqual(yield* f.refresh, { metadataPending: false });
            if (existingSetup) {
              assert.equal(yield* f.fs.readFileString(`${f.root}/.git/config`), config);
              assert.strictEqual(f.records.get(THREAD_VM_GIT_SETUP_SECRET), receipt);
            }
            f.setMetadata({ status: "pending", appId: "13" });
            assert.deepEqual(yield* f.refresh, { metadataPending: true });
            assert.equal(yield* f.git(["config", "user.name"]), "");
            assert.equal(yield* f.git(["config", "user.email"]), "");
            const nextBot: RelayThreadVmGitMetadata = {
              ...bot,
              appId: "13",
              appSlug: "replacement",
              botUserId: 456,
              name: "replacement[bot]",
              email: "456+replacement[bot]@users.noreply.github.com",
            };
            f.setMetadata(nextBot);
            assert.deepEqual(yield* f.refresh, { metadataPending: false });
            assert.equal(yield* f.git(["config", "user.name"]), nextBot.name);
            assert.equal(yield* f.git(["config", "user.email"]), nextBot.email);
            f.setOffline();
            assert.deepEqual(yield* f.refresh, { metadataPending: true });
            assert.equal(yield* f.git(["config", "user.name"]), nextBot.name);
            assert.strictEqual(f.records.get(THREAD_VM_IDENTITY_SECRET), identity);
            assert.deepEqual(yield* readThreadVmRepositoryBinding().pipe(f.provide), {
              operationId: f.owner.operationId,
              environmentId: f.owner.environmentId,
              scope: f.scope,
              canonicalKey: f.canonicalKey,
            });
            assert.equal((yield* f.fence.get(f.owner.threadId))?.operationId, resumed.operationId);
            assert.equal(yield* f.git(["symbolic-ref", "--short", "HEAD"]), "feature");
            assert.equal(yield* f.git(["status", "--porcelain=v1"]), status);
            assert.equal(yield* f.git(["show", ":staged.txt"]), "staged");
            assert.equal(yield* f.fs.readFileString(`${f.root}/staged.txt`), "dirty\n");
            assert.equal(yield* f.fs.readFileString(`${f.root}/untracked.txt`), "untracked\n");
            assert.lengthOf(yield* f.sql`SELECT 1 FROM checkout_operations`, 0);
          }),
        ).pipe(Effect.provide(environment)),
    );
  }

  for (const reactivate of [false, true]) {
    it.effect(
      `rejects refresh overtaken by a newer ${reactivate ? "active" : "draining"} operation`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.configure;
            const config = yield* f.fs.readFileString(`${f.root}/.git/config`),
              receipt = f.records.get(THREAD_VM_GIT_SETUP_SECRET),
              entered = yield* Deferred.make<void>(),
              release = yield* Deferred.make<void>(),
              resumed = { ...f.owner, operationId: "00000000-0000-4000-8000-000000000002" };
            if (reactivate) f.setMetadata({ status: "pending", appId: "13" });
            f.setBeforeReply(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
            const refreshing = yield* f.refresh.pipe(Effect.flip, Effect.forkChild);
            yield* Deferred.await(entered);
            yield* f.fence.beginDrain({ ...resumed, previousOperationId: f.owner.operationId });
            if (reactivate) yield* f.fence.activate(resumed);
            yield* Deferred.succeed(release, undefined);
            assert.include((yield* Fiber.join(refreshing)).message, "no longer owns");
            assert.equal(yield* f.fs.readFileString(`${f.root}/.git/config`), config);
            assert.strictEqual(f.records.get(THREAD_VM_GIT_SETUP_SECRET), receipt);
            assert.lengthOf(yield* f.sql`SELECT 1 FROM checkout_operations`, 0);
            if (reactivate) assert.deepEqual(yield* f.refresh, { metadataPending: true });
          }),
        ).pipe(Effect.provide(environment)),
    );
  }

  it.effect("rejects stale active callers and mismatched VM scope before requesting metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(),
          resumed = { ...f.owner, operationId: "00000000-0000-4000-8000-000000000002" };
        yield* f.fence.beginDrain({ ...resumed, previousOperationId: f.owner.operationId });
        yield* f.fence.activate(resumed);
        yield* f.configure.pipe(Effect.flip);
        for (const owner of [
          { ...resumed, environmentId: "foreign" },
          { ...resumed, generation: f.owner.generation + 1 },
          { ...resumed, threadId: "foreign" },
          { ...resumed, relayUrl: "https://foreign.test" },
        ])
          yield* configureThreadVmRepository(owner, f.root, "active").pipe(f.provide, Effect.flip);
        assert.equal(f.calls(), 0);
        assert.equal(f.records.has(THREAD_VM_GIT_SETUP_SECRET), false);
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect(
    "repairs active old state, avoids repeat writes, and refreshes changed App metadata",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          assert.deepEqual(yield* f.refresh, { metadataPending: false });
          const first = yield* f.fs.readFileString(`${f.root}/.git/config`),
            firstReceipt = f.records.get(THREAD_VM_GIT_SETUP_SECRET);
          yield* f.configure;
          assert.equal(yield* f.fs.readFileString(`${f.root}/.git/config`), first);
          assert.strictEqual(f.records.get(THREAD_VM_GIT_SETUP_SECRET), firstReceipt);
          f.setMetadata({ status: "pending", appId: "different-app" });
          assert.deepEqual(yield* f.refresh, { metadataPending: true });
          assert.equal(yield* f.git(["config", "user.name"]), "");
          assert.lengthOf(yield* f.sql`SELECT 1 FROM checkout_operations`, 0);
        }),
      ).pipe(Effect.provide(environment)),
  );

  it.effect(
    "uses cached binding and author offline without leaving checkout admission behind",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.configure;
          f.setOffline();
          assert.deepEqual(yield* f.configure, { metadataPending: true });
          yield* f.git(["commit", "--allow-empty", "-m", "offline bot commit"]);
          assert.equal(yield* f.git(["show", "-s", "--format=%ae"]), bot.email);
          assert.lengthOf(yield* f.sql`SELECT 1 FROM checkout_operations`, 0);
        }),
      ).pipe(Effect.provide(environment)),
  );

  it.effect(
    "publishes before recording receipt and retries interrupted receipt without a durable busy operation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          f.failReceipt(true);
          yield* f.configure.pipe(Effect.flip);
          assert.equal(yield* f.git(["config", "user.name"]), bot.name);
          assert.equal(f.records.has(THREAD_VM_GIT_SETUP_SECRET), false);
          assert.lengthOf(yield* f.sql`SELECT 1 FROM checkout_operations`, 0);
          f.failReceipt(false);
          yield* f.configure;
          assert.equal(f.records.has(THREAD_VM_GIT_SETUP_SECRET), true);
          assert.equal(yield* f.fs.exists(`${f.root}/.git/config.lock`), false);
        }),
      ).pipe(Effect.provide(environment)),
  );

  it.effect("admits exact installed frozen import and rejects a foreign or unfinished claim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture("import");
        yield* configureThreadVmRepository(
          { ...f.owner, operationId: "00000000-0000-4000-8000-000000000002" },
          f.root,
          "import",
        ).pipe(f.provide, Effect.flip);
        yield* f.sql`UPDATE thread_checkout_claims SET phase='reserved'`;
        yield* f.configure.pipe(Effect.flip);
        assert.equal(f.calls(), 0);
        yield* f.sql`UPDATE thread_checkout_claims SET phase='installed',generation=3`;
        yield* f.configure.pipe(Effect.flip);
        yield* f.sql`UPDATE thread_checkout_claims SET generation=2`;
        yield* f.configure;
        assert.equal(
          yield* f.git(["remote", "get-url", "origin"]),
          "https://github.com/acme/project.git",
        );
        assert.equal(yield* f.git(["config", "commit.gpgsign"]), "false");
        assert.lengthOf(yield* f.sql`SELECT 1 FROM checkout_operations`, 0);
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect("active repair respects checkout capture admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* makeCheckoutCapture(f.sql).acquireDrain({
          ...f.owner,
          checkoutRoot: f.root,
          gitCommonRoot: `${f.root}/.git`,
        });
        yield* f.configure.pipe(Effect.flip);
        assert.equal(f.records.has(THREAD_VM_GIT_SETUP_SECRET), false);
        assert.lengthOf(yield* f.sql`SELECT 1 FROM checkout_operations`, 0);
        assert.notInclude(yield* f.fs.readFileString(`${f.root}/.git/config`), "credential");
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect("rechecks mutable include files even with a valid setup receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(),
          included = `${f.root}/included`;
        yield* f.fs.writeFileString(included, "[custom]\n\tkeep = yes\n");
        yield* f.git(["config", "include.path", included]);
        yield* f.configure;
        yield* f.fs.writeFileString(included, '[remote "origin"]\n\tpush = HEAD:refs/heads/main\n');
        assert.include(
          (yield* f.configure.pipe(Effect.flip)).message,
          "included Git configuration",
        );
        assert.lengthOf(yield* f.sql`SELECT 1 FROM checkout_operations`, 0);
      }),
    ).pipe(Effect.provide(environment)),
  );

  it.effect(
    "repairs legacy generation one with fully matching bootstrap receipts and old relay replies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture("active", 1);
          const initial = {
            input: {
              workspace: {
                operationId: f.owner.operationId,
                scope: f.scope,
                canonicalKey: f.canonicalKey,
                branch: "feature",
                revision: "a".repeat(40),
              },
              title: "Legacy thread",
              modelSelection: { instanceId: "codex", model: "model" },
              createdAt: "2026-10-01T00:00:00Z",
            },
            workspaceRoot: f.root,
            receipt: {
              version: 1,
              operationId: f.owner.operationId,
              environmentId: f.owner.environmentId,
              projectId: "project",
              scope: f.scope,
              workspaceRoot: f.root,
              revision: "a".repeat(40),
              sequence: 2,
              execution: "frozen",
            },
          };
          f.setOffline();
          f.records.set(
            THREAD_VM_INITIAL_STATE_SECRET,
            new TextEncoder().encode(
              encode({
                ...initial,
                receipt: { ...initial.receipt, scope: { ...f.scope, repositoryId: "foreign" } },
              }),
            ),
          );
          yield* f.configure.pipe(Effect.flip);
          const resumed = { ...f.owner, operationId: "00000000-0000-4000-8000-000000000002" };
          yield* f.fence.beginDrain({ ...resumed, previousOperationId: f.owner.operationId });
          yield* f.fence.activate(resumed);
          f.records.set(THREAD_VM_INITIAL_STATE_SECRET, new TextEncoder().encode(encode(initial)));
          assert.deepEqual(yield* f.refresh, { metadataPending: true });
          assert.equal(yield* f.git(["config", "user.name"]), "");
          assert.equal(yield* f.git(["config", "credential.useHttpPath"]), "true");
        }),
      ).pipe(Effect.provide(environment)),
  );
});
