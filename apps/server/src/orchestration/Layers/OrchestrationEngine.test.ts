// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { makeThreadHistorySync } from "../../relay/ThreadHistorySync.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { OrchestrationEvent as EventSchema } from "@t3tools/contracts";
import { OrchestrationCommandReceipt } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  ThreadHistoryBaselineImporter,
  type ThreadHistoryBaselineInput,
} from "../../relay/ThreadHistoryBaseline.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  EnvironmentId,
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadExecutionFence } from "../../persistence/ThreadExecutionFence.ts";
import { makeCheckoutCapture } from "../../persistence/CheckoutCapture.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as OrchestrationCommandReceipts from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

function makeOrchestrationLayer(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  rejectProjection?: (event: OrchestrationEvent) => boolean,
) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  const pipeline = rejectProjection
    ? Layer.effect(
        OrchestrationProjectionPipeline,
        Effect.gen(function* () {
          const inner = yield* OrchestrationProjectionPipeline;
          return {
            ...inner,
            projectEventDeferred: (event: OrchestrationEvent) =>
              rejectProjection(event)
                ? Effect.fail(
                    new PersistenceSqlError({
                      operation: "test.preparation",
                      detail: "Injected preparation projection failure",
                    }),
                  )
                : inner.projectEventDeferred(event),
          };
        }),
      ).pipe(Layer.provide(OrchestrationProjectionPipelineLive))
    : OrchestrationProjectionPipelineLive;
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(pipeline),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      repositoryIdentityResolver
        ? Layer.succeed(
            RepositoryIdentityResolver.RepositoryIdentityResolver,
            repositoryIdentityResolver,
          )
        : RepositoryIdentityResolver.layer,
    ),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function createOrchestrationSystem(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  rejectProjection?: (event: OrchestrationEvent) => boolean,
  providers?: Pick<ProviderInstanceRegistry["Service"], "getInstance">,
) {
  const layer = makeOrchestrationLayer(databasePath, repositoryIdentityResolver, rejectProjection);
  const runtime = ManagedRuntime.make(
    providers
      ? layer.pipe(Layer.provideMerge(Layer.mock(ProviderInstanceRegistry)(providers)))
      : layer,
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const fence = await runtime.runPromise(Effect.map(SqlClient.SqlClient, makeThreadExecutionFence));
  return {
    fence,
    sql: await runtime.runPromise(SqlClient.SqlClient),
    engine,
    attachmentDirectory: () =>
      runtime.runPromise(Effect.map(ServerConfig, (config) => config.attachmentsDir)),
    rebuildProjections: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projection_state SET last_applied_sequence = 0`;
          yield* (yield* OrchestrationProjectionPipeline).bootstrap;
        }),
      ),
    importBaseline: (input: ThreadHistoryBaselineInput) =>
      runtime.runPromise(
        Effect.flatMap(ThreadHistoryBaselineImporter, (importer) => importer.install(input)),
      ),
    importedEvents: (input: ThreadHistoryBaselineInput) =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* engine.subscribeDomainEvents;
            const result = yield* (yield* ThreadHistoryBaselineImporter).install(input);
            return { result, events: yield* Stream.runCollect(stream.pipe(Stream.take(1))) };
          }),
        ),
      ),
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    readShell: () => runtime.runPromise(snapshotQuery.getShellSnapshot()),
    readThread: (threadId: ThreadId) =>
      runtime.runPromise(snapshotQuery.getThreadDetailById(threadId)),
    receipt: (commandId: CommandId) =>
      runtime.runPromise(
        Effect.flatMap(
          OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository,
          (receipts) => receipts.getByCommandId({ commandId }),
        ),
      ),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    confirmDeletedThreadCleanup: (threadId: ThreadId) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM thread_cleanup_fences WHERE thread_id = ${threadId}`;
        }),
      ),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it("reserves accepted starts and holds new work only in the captured physical checkout", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "engine-capture-")),
    );
    const checkout = NodePath.join(root, "checkout");
    const alias = NodePath.join(root, "alias");
    const worktree = NodePath.join(root, "worktree");
    await NodeFSP.mkdir(checkout);
    await NodeFSP.mkdir(worktree);
    await NodeFSP.symlink(checkout, alias);
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("capture-project");
    const accepted = ThreadId.make("accepted");
    const waiting = ThreadId.make("waiting");
    const independent = ThreadId.make("independent");
    const capture = makeCheckoutCapture(system.sql);
    const owner = {
      operationId: "capture",
      threadId: "moving",
      environmentId: "local",
      generation: 1,
    };
    const start = (threadId: ThreadId, commandId: string) =>
      system.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(commandId),
        threadId,
        message: {
          messageId: MessageId.make(commandId),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now(),
      });
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("capture-project"),
          projectId,
          title: "Capture",
          workspaceRoot: checkout,
          createdAt: now(),
        }),
      );
      for (const [threadId, worktreePath] of [
        [accepted, null],
        [waiting, alias],
        [independent, worktree],
      ] as const)
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${threadId}`),
            threadId,
            projectId,
            title: threadId,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath,
            createdAt: now(),
          }),
        );
      await system.run(start(accepted, "accepted-before-capture"));
      const admitted = await system.run(
        capture.lookupAdmission(accepted, "request:accepted-before-capture", "provider"),
      );
      expect(admitted).toMatchObject({ checkoutRoot: checkout, completed: 0 });
      await system.run(
        capture.acquireDrain({
          ...owner,
          checkoutRoot: checkout,
          gitCommonRoot: NodePath.join(checkout, ".git"),
        }),
      );
      await expect(system.run(capture.enterCapturing(owner))).rejects.toThrow(
        "admitted checkout work",
      );
      await expect(system.run(start(waiting, "rejected-by-capture"))).rejects.toThrow(
        "Waiting for this checkout",
      );
      expect(
        await system.run(
          capture.lookupAdmission(waiting, "request:rejected-by-capture", "provider"),
        ),
      ).toBeNull();
      expect(
        (await system.readModel()).threads.find((thread) => thread.id === waiting)?.messages,
      ).toHaveLength(0);
      await system.run(start(independent, "worktree-start"));
      await system.run(capture.complete(admitted!.admissionId));
      await system.run(capture.enterCapturing(owner));
      await system.run(
        capture.release(owner, { outcome: "sealed", manifestSha256: "a".repeat(64) }),
      );
      await system.run(start(waiting, "after-capture"));
      expect(
        await system.run(capture.lookupAdmission(waiting, "request:after-capture", "provider")),
      ).toMatchObject({ checkoutRoot: checkout, completed: 0 });
    } finally {
      await system.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("registers unrelated canonical roots while retaining uncertain checkout operations", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-registration-")),
    );
    const held = NodePath.join(root, "held");
    const unrelated = NodePath.join(root, "unrelated");
    const lookalike = NodePath.join(root, "held-other");
    const alias = NodePath.join(root, "alias");
    const sibling = NodePath.join(root, "sibling");
    const siblingAlias = NodePath.join(root, "sibling-alias");
    for (const directory of [held, unrelated, lookalike, sibling]) await NodeFSP.mkdir(directory);
    await NodeFSP.symlink(held, alias);
    await NodeFSP.symlink(sibling, siblingAlias);
    const system = await createOrchestrationSystem(undefined, {
      resolve: () => Effect.succeed(null),
    });
    let serial = 0;
    const create = (workspaceRoot: string) =>
      system.run(
        system.engine.dispatch({
          type: "project.create",
          projectId: ProjectId.make(`registration-${++serial}`),
          commandId: CommandId.make(`registration-${serial}`),
          title: "Project",
          workspaceRoot,
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
    try {
      await create(held);
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          threadId: ThreadId.make("registration-sibling"),
          projectId: ProjectId.make("registration-1"),
          commandId: CommandId.make("registration-sibling"),
          title: "Sibling",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "sibling",
          worktreePath: sibling,
          createdAt: now(),
        }),
      );
      await system.run(
        Effect.gen(function* () {
          yield* system.sql`INSERT INTO checkout_operations(operation_id,kind) VALUES ('uncertain','vcs')`;
          yield* system.sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES ('uncertain',${held})`;
          yield* system.sql`INSERT INTO checkout_operation_projects(operation_id,project_id) VALUES ('uncertain','registration-1')`;
        }),
      );
      await create(unrelated);
      await create(lookalike);
      for (const directory of [
        held,
        alias,
        NodePath.join(alias, "not-created"),
        sibling,
        siblingAlias,
        NodePath.join(siblingAlias, "not-created"),
        root,
        NodePath.parse(root).root,
      ])
        await expect(create(directory)).rejects.toThrow("checkout operations");
      // Metadata/path changes on an existing project keep their existing guard.
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.meta.update",
            projectId: ProjectId.make("registration-2"),
            commandId: CommandId.make("registration-change-existing-path"),
            workspaceRoot: lookalike,
          }),
        ),
      ).rejects.toThrow("checkout operations");
      expect(
        await system.run(system.sql`SELECT operation_id,kind FROM checkout_operations`),
      ).toEqual([{ operation_id: "uncertain", kind: "vcs" }]);
      expect((await system.readModel()).projects).toHaveLength(3);
    } finally {
      await system.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps new aliases of reserved installations blocked without blocking an unrelated project", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-installation-")),
    );
    const repository = NodePath.join(root, "repository"),
      checkout = NodePath.join(root, "checkout"),
      unrelated = NodePath.join(root, "unrelated");
    for (const directory of [repository, checkout, unrelated]) await NodeFSP.mkdir(directory);
    const alias = NodePath.join(root, "alias");
    await NodeFSP.symlink(checkout, alias);
    const system = await createOrchestrationSystem(undefined, {
      resolve: () => Effect.succeed(null),
    });
    let serial = 0;
    const create = (workspaceRoot: string) =>
      system.run(
        system.engine.dispatch({
          type: "project.create",
          projectId: ProjectId.make(`installation-${++serial}`),
          commandId: CommandId.make(`installation-${serial}`),
          title: "Project",
          workspaceRoot,
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
    try {
      await create(repository);
      await system.run(
        system.fence.prepare({
          threadId: "moving",
          projectId: "installation-1",
          environmentId: "destination",
          relayUrl: "https://relay.example",
          generation: 2,
          operationId: "install",
        }),
      );
      await system.run(system.sql`INSERT INTO thread_checkout_claims
        (operation_id,thread_id,generation,project_id,repository_root,checkout_path,mode,branch,manifest_sha256,workspace_sha256,inspection_json,phase)
        VALUES ('install','moving',2,'installation-1',${repository},${checkout},'worktree','move',${"a".repeat(64)},${"b".repeat(64)},'{}','installing')`);
      await create(unrelated);
      for (const directory of [repository, checkout, alias, NodePath.join(repository, "new"), root])
        await expect(create(directory)).rejects.toThrow(/checkout|reserved/);
      expect(
        await system.run(
          system.sql`SELECT phase FROM thread_checkout_claims WHERE operation_id='install'`,
        ),
      ).toEqual([{ phase: "installing" }]);
      expect((await system.readModel()).projects).toHaveLength(2);
    } finally {
      await system.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unregistered linked worktrees during uncertain work but allows an independent clone", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-linked-registration-")),
    );
    const main = NodePath.join(root, "main"),
      linked = NodePath.join(root, "linked"),
      clone = NodePath.join(root, "clone"),
      alias = NodePath.join(root, "alias");
    await NodeFSP.mkdir(main);
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "0",
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@localhost",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@localhost",
        },
        stdio: "pipe",
      });
    git(main, ["init", "-b", "main"]);
    await NodeFSP.writeFile(NodePath.join(main, "baseline.txt"), "public fixture\n");
    git(main, ["add", "."]);
    git(main, ["commit", "-m", "base"]);
    git(main, ["worktree", "add", "-b", "linked", linked]);
    git(root, ["clone", "--no-local", main, clone]);
    await NodeFSP.mkdir(NodePath.join(linked, "nested"));
    await NodeFSP.symlink(linked, alias);
    expect((await NodeFSP.stat(NodePath.join(linked, ".git"))).isFile()).toBe(true);
    expect((await NodeFSP.stat(NodePath.join(clone, ".git"))).isDirectory()).toBe(true);
    const system = await createOrchestrationSystem(undefined, {
      resolve: () => Effect.succeed(null),
    });
    let serial = 0;
    const create = (workspaceRoot: string) =>
      system.run(
        system.engine.dispatch({
          type: "project.create",
          projectId: ProjectId.make(`linked-registration-${++serial}`),
          commandId: CommandId.make(`linked-registration-${serial}`),
          title: "Project",
          workspaceRoot,
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
    try {
      await create(main);
      await system.run(
        Effect.gen(function* () {
          yield* system.sql`INSERT INTO checkout_operations(operation_id,kind) VALUES ('linked-uncertain','vcs')`;
          yield* system.sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES ('linked-uncertain',${main})`;
          yield* system.sql`INSERT INTO checkout_operation_projects(operation_id,project_id) VALUES ('linked-uncertain','linked-registration-1')`;
        }),
      );
      await create(clone);
      for (const directory of [linked, alias, NodePath.join(linked, "nested")])
        await expect(create(directory)).rejects.toThrow("checkout operations");
      // The reverse direction also matters when the admitted worktree was
      // never registered and therefore has no operation-project association.
      await system.run(
        Effect.gen(function* () {
          yield* system.sql`DELETE FROM checkout_operations WHERE operation_id='linked-uncertain'`;
          yield* system.sql`INSERT INTO checkout_operations(operation_id,kind) VALUES ('unregistered-linked','vcs')`;
          yield* system.sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES ('unregistered-linked',${linked})`;
        }),
      );
      await expect(create(main)).rejects.toThrow("checkout operations");
      const independentChild = NodePath.join(clone, "nested");
      await NodeFSP.mkdir(independentChild);
      await create(independentChild);
      expect((await system.readModel()).projects).toHaveLength(3);
      expect(await system.run(system.sql`SELECT operation_id FROM checkout_operations`)).toEqual([
        { operation_id: "unregistered-linked" },
      ]);
      // Shared metadata writes also protect the other worktrees.
      await system.run(
        Effect.gen(function* () {
          yield* system.sql`DELETE FROM checkout_operations WHERE operation_id='unregistered-linked'`;
          yield* system.sql`INSERT INTO checkout_operations(operation_id,kind) VALUES ('metadata-write','write-file')`;
          yield* system.sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES ('metadata-write',${NodePath.join(main, ".git", "config")})`;
        }),
      );
      await expect(create(linked)).rejects.toThrow("checkout operations");
      await system.run(
        Effect.gen(function* () {
          yield* system.sql`DELETE FROM checkout_operations WHERE operation_id='metadata-write'`;
          yield* system.fence.prepare({
            threadId: "linked-install",
            projectId: "linked-registration-1",
            environmentId: "destination",
            relayUrl: "https://relay.example",
            generation: 2,
            operationId: "linked-install",
          });
          yield* system.sql`INSERT INTO thread_checkout_claims
          (operation_id,thread_id,generation,project_id,repository_root,checkout_path,mode,branch,manifest_sha256,workspace_sha256,inspection_json,phase)
          VALUES ('linked-install','linked-install',2,'linked-registration-1',${main},${main},'main','main',${"a".repeat(64)},${"b".repeat(64)},'{}','installing')`;
        }),
      );
      await expect(create(linked)).rejects.toThrow("checkout operations");
      expect(
        await system.run(
          system.sql`SELECT phase FROM thread_checkout_claims WHERE operation_id='linked-install'`,
        ),
      ).toEqual([{ phase: "installing" }]);
      // Test-only completion of this synthetic installation leaves a separate
      // frozen thread as the sole source of the shared-metadata hold.
      await system.run(
        system.sql`UPDATE thread_checkout_claims SET phase='released' WHERE operation_id='linked-install'`,
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          threadId: ThreadId.make("linked-frozen"),
          projectId: ProjectId.make("linked-registration-1"),
          commandId: CommandId.make("linked-frozen"),
          title: "Frozen",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await system.run(
        system.fence.prepare({
          threadId: "linked-frozen",
          projectId: "linked-registration-1",
          environmentId: "destination",
          relayUrl: "https://relay.example",
          generation: 2,
          operationId: "linked-frozen",
        }),
      );
      await expect(create(linked)).rejects.toThrow("checkout operations");
      const independentOther = NodePath.join(clone, "another");
      await NodeFSP.mkdir(independentOther);
      await create(independentOther);
      expect((await system.readModel()).projects).toHaveLength(4);
    } finally {
      await system.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an uncertain checkout operation has no recorded path", async () => {
    const system = await createOrchestrationSystem(undefined, {
      resolve: () => Effect.succeed(null),
    });
    try {
      await system.run(
        system.sql`INSERT INTO checkout_operations(operation_id,kind) VALUES ('unknown-path','vcs')`,
      );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.create",
            projectId: ProjectId.make("unknown-operation-project"),
            commandId: CommandId.make("unknown-operation-project"),
            title: "Project",
            workspaceRoot: NodeOS.tmpdir(),
            defaultModelSelection: null,
            createdAt: now(),
          }),
        ),
      ).rejects.toThrow("checkout operations");
      expect((await system.readModel()).projects).toHaveLength(0);
      expect(await system.run(system.sql`SELECT operation_id FROM checkout_operations`)).toEqual([
        { operation_id: "unknown-path" },
      ]);
    } finally {
      await system.dispose();
    }
  });

  effectIt.effect("starts queued turn timing at admission without counting its paused wait", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now()));
      const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("queued-clock-project");
      const threadId = ThreadId.make("queued-clock-thread");
      const messageId = MessageId.make("queued-clock-message");
      const turnId = TurnId.make("queued-clock-turn");
      const enqueuedAt = yield* timestamp;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("queued-clock-project"),
        projectId,
        title: "Queued clock",
        workspaceRoot: "/tmp/queued-clock",
        createdAt: enqueuedAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("queued-clock-thread"),
        projectId,
        threadId,
        title: "Queued clock",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: enqueuedAt,
      });
      yield* engine.dispatch({
        type: "thread.queue.pause",
        commandId: CommandId.make("queued-clock-pause"),
        threadId,
        createdAt: enqueuedAt,
      });
      yield* engine.dispatch({
        type: "thread.prompt.enqueue",
        commandId: CommandId.make("queued-clock-enqueue"),
        threadId,
        message: { messageId, text: "Run after the paused wait.", attachments: [] },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: enqueuedAt,
      });
      yield* TestClock.adjust("5 minutes");
      const queued = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
      yield* engine.dispatch({
        type: "thread.queue.resume",
        commandId: CommandId.make("queued-clock-resume"),
        threadId,
        expectedRevision: queued.promptQueue!.revision,
        createdAt: yield* timestamp,
      });
      const resumed = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
      const attemptId = CommandId.make("queued-clock-claim");
      yield* engine.dispatch({
        type: "thread.prompt.claim",
        commandId: attemptId,
        threadId,
        messageId,
        expectedRevision: resumed.promptQueue!.entries[0]!.revision,
        expectedControlRevision: resumed.promptQueue!.revision,
        createdAt: yield* timestamp,
      });
      yield* TestClock.adjust("1 second");
      const admittedAt = yield* timestamp;
      yield* engine.dispatch({
        type: "thread.prompt.admit",
        commandId: CommandId.make("queued-clock-admit"),
        threadId,
        attemptId,
        turnId,
        evidence: "provider-ack",
        createdAt: admittedAt,
      });
      const session = {
        threadId,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access" as const,
        lastError: null,
      };
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("queued-clock-running"),
        threadId,
        session: { ...session, status: "running", activeTurnId: turnId, updatedAt: admittedAt },
        createdAt: admittedAt,
      });
      yield* TestClock.adjust("17 seconds");
      const completedAt = yield* timestamp;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("queued-clock-completed"),
        threadId,
        session: { ...session, status: "ready", activeTurnId: null, updatedAt: completedAt },
        createdAt: completedAt,
      });
      const [turn] = yield* sql<{
        requestedAt: string;
        startedAt: string;
        completedAt: string;
      }>`SELECT requested_at AS "requestedAt",started_at AS "startedAt",completed_at AS "completedAt"
          FROM projection_turns WHERE thread_id=${threadId} AND turn_id=${turnId}`;
      expect(turn).toEqual({ requestedAt: admittedAt, startedAt: admittedAt, completedAt });
      expect(Date.parse(turn!.completedAt) - Date.parse(turn!.startedAt)).toBe(17_000);
      const thread = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
      expect(thread.messages.find((message) => message.id === messageId)).toMatchObject({
        createdAt: enqueuedAt,
        updatedAt: admittedAt,
      });
      const events = yield* Stream.runCollect(engine.readEvents(0));
      const admitted = events.find((event) => event.type === "thread.turn-start-requested");
      expect(admitted?.occurredAt).toBe(admittedAt);
      expect(admitted?.payload.createdAt).toBe(admittedAt);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  it("accepts one native answer while preserving the shared queue pause", async () => {
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("native-question-project");
    const threadId = ThreadId.make("native-question-thread");
    const requestId = ApprovalRequestId.make("native-question");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("native-project"),
          projectId,
          title: "Questions",
          workspaceRoot: "/tmp/native-questions",
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("native-thread"),
          threadId,
          projectId,
          title: "Questions",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.queue.pause",
          commandId: CommandId.make("native-pause"),
          threadId,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("native-request"),
          threadId,
          createdAt: now(),
          activity: {
            id: EventId.make("native-request"),
            kind: "user-input.requested",
            summary: "Question",
            tone: "info",
            turnId: null,
            createdAt: now(),
            payload: {
              requestId,
              questions: [{ id: "q", header: "Name", question: "What name?", options: [] }],
            },
          },
        }),
      );
      const answers = ["Alice", "Bob"].map((name) => ({
        type: "thread.user-input.respond" as const,
        commandId: CommandId.make(`native-answer-${name}`),
        threadId,
        requestId,
        answers: { q: name },
        author: { userId: name, displayName: name, imageUrl: null },
        createdAt: now(),
      }));
      const results = await Promise.allSettled(
        answers.map((answer) => system.run(system.engine.dispatch(answer))),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.promptQueue?.enabled).toBe(false);
      expect(thread.promptQueue?.pauseReason?.code).toBe("stopped");
      expect(thread.messages).toHaveLength(0);
      const claims = thread.activities.filter(
        (activity) => activity.kind === "user-input.answer-submitted",
      );
      expect(claims).toHaveLength(1);
      const winner = answers[results.findIndex((result) => result.status === "fulfilled")]!;
      expect(claims[0]?.payload).toMatchObject({ answers: winner.answers, author: winner.author });
      const events = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0))));
      expect(
        events.filter((event) => event.type === "thread.user-input-response-requested"),
      ).toHaveLength(1);
      await expect(system.run(system.engine.dispatch(winner))).resolves.toBeDefined();
    } finally {
      await system.dispose();
    }
  });

  it("persists shared queue order, receipts, staged delivery and provenance across restart", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-shared-queue-"));
    const databasePath = NodePath.join(directory, "state.sqlite");
    let system = await createOrchestrationSystem(databasePath);
    const projectId = ProjectId.make("shared-project");
    const threadId = ThreadId.make("shared-thread");
    const author = { userId: "alice", displayName: "Alice", imageUrl: null };
    const editor = { userId: "bob", displayName: "Bob", imageUrl: null };
    const enqueue = {
      type: "thread.prompt.enqueue" as const,
      commandId: CommandId.make("shared-enqueue"),
      threadId,
      message: { messageId: MessageId.make("shared-message"), text: "accepted", attachments: [] },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      author,
      createdAt: now(),
    };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("shared-project"),
          projectId,
          title: "Shared",
          workspaceRoot: directory,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("shared-thread"),
          threadId,
          projectId,
          title: "Shared",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const accepted = await system.run(system.engine.dispatch(enqueue));
      await system.run(
        system.engine.dispatch({
          ...enqueue,
          type: "thread.prompt.edit",
          commandId: CommandId.make("shared-edit"),
          messageId: enqueue.message.messageId,
          expectedRevision: 1,
          message: { text: "edited", attachments: [] },
          author: editor,
        }),
      );
      await system.dispose();
      system = await createOrchestrationSystem(databasePath);
      expect(await system.run(system.engine.dispatch(enqueue))).toEqual(accepted);
      let thread = (await system.readModel()).threads[0]!;
      expect(thread.messages).toHaveLength(0);
      expect(thread.promptQueue?.entries).toHaveLength(1);
      expect(thread.promptQueue?.entries[0]).toMatchObject({
        author,
        editedBy: editor,
        text: "edited",
        revision: 2,
        acceptedSequence: accepted.sequence,
      });
      const attemptId = CommandId.make("shared-claim");
      await system.run(
        system.engine.dispatch({
          type: "thread.prompt.claim",
          commandId: attemptId,
          threadId,
          messageId: enqueue.message.messageId,
          expectedRevision: 2,
          expectedControlRevision: 0,
          createdAt: now(),
        }),
      );
      await system.dispose();
      system = await createOrchestrationSystem(databasePath);
      thread = (await system.readModel()).threads[0]!;
      expect(thread.promptQueue?.handoff?.attemptId).toBe(attemptId);
      expect(thread.messages).toHaveLength(0);
      await system.run(
        system.engine.dispatch({
          type: "thread.prompt.admit",
          commandId: CommandId.make("shared-admit"),
          threadId,
          attemptId,
          turnId: TurnId.make("shared-turn"),
          evidence: "provider-ack",
          createdAt: now(),
        }),
      );
      const detail = await system.readThread(threadId);
      expect(Option.getOrThrow(detail).messages[0]).toMatchObject({
        author,
        editedBy: editor,
        text: "edited",
      });
      await system.dispose();
      system = await createOrchestrationSystem(databasePath);
      thread = (await system.readModel()).threads[0]!;
      expect(thread.promptQueue?.awaitingTurnId).toBe("shared-turn");
      expect(thread.messages[0]).toMatchObject({ author, editedBy: editor, text: "edited" });
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["running", "stopped"] as const)(
    "sends async answers with a %s session and rejects old duplicate replies",
    async (status) => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-async-questions-"),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      let system = await createOrchestrationSystem(databasePath);
      const threadId = ThreadId.make("async-thread");
      const projectId = ProjectId.make("async-project");
      const requestId = ApprovalRequestId.make("codex-async:question-1");
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("async-project"),
            projectId,
            title: "Async questions",
            workspaceRoot: "/tmp/async-questions",
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("async-thread"),
            threadId,
            projectId,
            title: "Async questions",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("async-session"),
            threadId,
            createdAt: now(),
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
              lastError: null,
              updatedAt: now(),
            },
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("async-question"),
            threadId,
            createdAt: now(),
            activity: {
              id: EventId.make("async-question"),
              kind: "user-input.requested",
              summary: "User input requested",
              tone: "info",
              turnId: TurnId.make("turn-1"),
              createdAt: now(),
              payload: {
                requestId,
                responseMode: "message",
                questions: [
                  {
                    id: "0",
                    header: "Question",
                    question: "Which package manager?",
                    options: [{ label: "pnpm", description: "" }],
                  },
                  {
                    id: "1",
                    header: "Question",
                    question: "What should it be named?",
                    options: [],
                  },
                ],
              },
            },
          }),
        );
        const appendWork = async (prefix: string, createdAt: string) => {
          for (let index = 0; index < 501; index += 1) {
            await system.run(
              system.engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`${prefix}-${index}`),
                threadId,
                createdAt,
                activity: {
                  id: EventId.make(`${prefix}-${index}`),
                  kind: "tool.completed",
                  summary: "Work continued",
                  payload: {},
                  tone: "info",
                  turnId: TurnId.make("turn-1"),
                  createdAt,
                },
              }),
            );
          }
        };
        await appendWork("work", "2026-01-01T00:00:01.000Z");
        const before = await system.readModel();
        expect(
          before.threads[0]?.activities.some((activity) => activity.id === "async-question"),
        ).toBe(true);
        if (status === "stopped") {
          await system.dispose();
          system = await createOrchestrationSystem(databasePath);
        }
        const response = {
          type: "thread.user-input.respond" as const,
          commandId: CommandId.make("async-response"),
          threadId,
          requestId,
          answers: { "0": "pnpm", "1": "Example" },
          attachmentsByQuestionId: {
            "1": [
              {
                type: "file" as const,
                id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
                name: "spec.txt",
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ],
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        };
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("incomplete-answer"),
              answers: { "0": "pnpm" },
            }),
          ),
        ).rejects.toThrow("Answer each question before sending.");
        await system.run(system.engine.dispatch(response));
        const after = await system.readModel();
        const userMessages = after.threads[0]?.messages.filter(
          (message) => message.role === "user",
        );
        expect(userMessages).toHaveLength(1);
        expect(userMessages?.[0]?.attachments).toEqual(response.attachmentsByQuestionId["1"]);
        expect(userMessages?.[0]?.text).toBe(
          "Which package manager?\npnpm\n\nWhat should it be named?\nExample\nAttached file: spec.txt (thread-1-00000000-0000-4000-8000-0000000000aa-txt)",
        );
        expect(
          after.threads[0]?.activities.find((activity) => activity.kind === "user-input.resolved")
            ?.payload,
        ).toMatchObject({ requestId, responseMode: "message", answers: response.answers });
        const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
        expect(
          Array.from(events)
            .filter((event) => event.commandId === response.commandId)
            .map((event) => event.type),
        ).toEqual([
          "thread.activity-appended",
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("second-client-reply"),
            }),
          ),
        ).rejects.toThrow("This question has already been answered.");
        await appendWork("later-work", "2026-01-01T00:00:03.000Z");
        const afterEviction = Option.getOrThrow(await system.readThread(threadId));
        expect(
          afterEviction.activities.some((activity) => activity.kind === "user-input.resolved"),
        ).toBe(false);
        if (status === "stopped") {
          await system.dispose();
          system = await createOrchestrationSystem(databasePath);
        }
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("reply-after-eviction"),
            }),
          ),
        ).rejects.toThrow("This question has already been answered.");
      } finally {
        await system.dispose();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent;
          nextSequence += 1;
          return savedEvent;
        }),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          pullRequests: [],
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadSubscriptionAnchor: () => Effect.succeedNone,
          getUserInputActivity: () => Effect.die("unused"),
          listActivitiesByKind: () => Effect.die("unused"),
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getDeletedWorktreeThreads: () => Effect.die("unused"),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getEventReplayStats: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
          getProjectShellById: () => Effect.succeedNone,
          getProjectShells: () => Effect.succeed([]),
          getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
          getImportedAgentSessionSources: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.succeedNone,
          getFullThreadDiffContext: () => Effect.succeedNone,
          getThreadRuntimeContext: () => Effect.die("unused"),
          getTurnStartMessage: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeedNone,
          getThreadDetailById: () => Effect.succeedNone,
          getThreadDetailSnapshot: () => Effect.succeedNone,
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
          projectEventDeferred: () => Effect.succeed(Effect.void),
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(await runtime.runPromise(engine.latestSequence)).toBe(7);
    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    expect(result.sequence).toBe(8);
    expect(await runtime.runPromise(engine.latestSequence)).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  effectIt.effect("preserves the blocked-settle error and persists its rejected receipt", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const projectId = ProjectId.make("project-blocked-settle");
      const threadId = ThreadId.make("thread-blocked-settle");
      const commandId = CommandId.make("cmd-blocked-settle");
      const createdAt = now();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-blocked-settle-project-create"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-blocked-settle",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-blocked-settle-thread-create"),
        threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-blocked-settle-session-set"),
        threadId,
        createdAt,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
      });

      const sequence = yield* engine.latestSequence;
      const error = yield* engine
        .dispatch({ type: "thread.settle", commandId, threadId })
        .pipe(Effect.flip);
      const message =
        "This thread still needs attention. Resolve or interrupt it first, then try again.";
      expect(error).toMatchObject({
        _tag: "OrchestrationThreadSettleBlockedError",
        threadId,
        message,
      });
      expect(Option.getOrNull(yield* receipts.getByCommandId({ commandId }))).toMatchObject({
        commandId,
        aggregateKind: "thread",
        aggregateId: threadId,
        status: "rejected",
        projectId,
        error: message,
        resultSequence: sequence,
      });
      expect(yield* engine.latestSequence).toBe(sequence);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  effectIt.effect(
    "rejects persisted changes and live background work without blocking unrelated threads",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now()));
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const backgroundLiveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
        const projectId = ProjectId.make("project-auto-settle-guard");
        const guardedThreadId = ThreadId.make("thread-auto-settle-guarded");
        const unrelatedThreadId = ThreadId.make("thread-auto-settle-unrelated");
        const liveThreadId = ThreadId.make("thread-auto-settle-live");

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-auto-settle-guard-project"),
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project-auto-settle-guard",
          createdAt: now(),
        });
        for (const threadId of [guardedThreadId, unrelatedThreadId, liveThreadId]) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd-create-${threadId}`),
            threadId,
            projectId,
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now(),
          });
        }

        const beforeUpdate = yield* snapshots.getSnapshot();
        const snapshotSequence = beforeUpdate.snapshotSequence;
        const originalUpdatedAt = beforeUpdate.threads.find(
          (thread) => thread.id === guardedThreadId,
        )?.updatedAt;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-auto-settle-guard-meta"),
          threadId: guardedThreadId,
          branch: "new-branch",
        });
        const afterUpdate = yield* snapshots.getSnapshot();
        expect(afterUpdate.threads.find((thread) => thread.id === guardedThreadId)?.updatedAt).toBe(
          originalUpdatedAt,
        );

        // Automatic settlement stamps the last activity, never the sweep time.
        const lastActivityAt = "2025-12-20T00:00:00.000Z";
        const staleError = yield* engine
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make("cmd-auto-settle-stale-snapshot"),
            threadId: guardedThreadId,
            snapshotSequence,
            settledAt: lastActivityAt,
          })
          .pipe(Effect.flip);
        expect(staleError._tag).toBe("OrchestrationCommandInvariantError");

        const livenessSnapshotSequence = yield* engine.latestSequence;
        for (const [taskType, expectedLiveness] of [
          ["subagent", "working"],
          ["local_bash", "monitoring"],
        ] as const) {
          backgroundLiveness.recordTaskLiveness({
            threadId: liveThreadId,
            taskId: `task-${expectedLiveness}`,
            taskType,
            status: undefined,
            kind: "started",
          });
          expect(backgroundLiveness.getThreadBackgroundLiveness(liveThreadId)).toBe(
            expectedLiveness,
          );
          expect(yield* engine.latestSequence).toBe(livenessSnapshotSequence);

          const livenessError = yield* engine
            .dispatch({
              type: "thread.auto-settle",
              commandId: CommandId.make(`cmd-auto-settle-${expectedLiveness}`),
              threadId: liveThreadId,
              snapshotSequence: livenessSnapshotSequence,
              settledAt: lastActivityAt,
            })
            .pipe(Effect.flip);
          expect(livenessError._tag).toBe("OrchestrationCommandInvariantError");
          expect(yield* engine.latestSequence).toBe(livenessSnapshotSequence);
          backgroundLiveness.clearThreadLiveness(liveThreadId);
        }

        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle-after-liveness-cleared"),
          threadId: liveThreadId,
          snapshotSequence: livenessSnapshotSequence,
          settledAt: lastActivityAt,
        });

        const freshSnapshotSequence = yield* engine.latestSequence;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-auto-settle-unrelated-meta"),
          threadId: unrelatedThreadId,
          title: "Unrelated update",
        });
        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle-after-unrelated-update"),
          threadId: guardedThreadId,
          snapshotSequence: freshSnapshotSequence,
          settledAt: lastActivityAt,
        });

        const settled = yield* snapshots.getSnapshot();
        for (const threadId of [guardedThreadId, liveThreadId]) {
          const thread = settled.threads.find((candidate) => candidate.id === threadId);
          expect(thread?.settledOverride).toBe("settled");
          expect(thread?.settledAt).toBe(lastActivityAt);
          expect(thread?.updatedAt).toBe(now());
        }
      }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("keeps the author of a user message from the command to the read model", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const author = { userId: "user_alice", displayName: "Alice", imageUrl: null };

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-author"),
        projectId: asProjectId("project-author"),
        title: "Project Author",
        workspaceRoot: "/tmp/project-author",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-author"),
        threadId: ThreadId.make("thread-author"),
        projectId: asProjectId("project-author"),
        title: "Who wrote this",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-author"),
        threadId: ThreadId.make("thread-author"),
        message: {
          messageId: asMessageId("msg-author"),
          role: "user",
          text: "hello from Alice",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        author,
        createdAt,
      }),
    );

    const readModel = await system.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-author"));
    expect(thread?.messages.map((message) => [message.text, message.author])).toEqual([
      ["hello from Alice", author],
    ]);
    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-archive-title-regeneration"),
        threadId: ThreadId.make("thread-archive"),
        regenerateTitle: true,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();
    await system.run(
      engine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("cmd-thread-archive-stale-title-completion"),
        threadId: ThreadId.make("thread-archive"),
        requestId: CommandId.make("cmd-thread-archive-title-regeneration"),
        title: "Stale generated title",
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")?.title,
    ).toBe("Archive me");

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("does not regress a generated branch to a stale temporary worktree branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-branch-race-project-create"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Project",
        workspaceRoot: "/tmp/project-branch-race",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-branch-race-thread-create"),
        threadId: ThreadId.make("thread-branch-race"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "t3code/generated-branch-name",
        worktreePath: "/tmp/project-branch-race-worktree",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-stale-temporary-branch-sync"),
        threadId: ThreadId.make("thread-branch-race"),
        branch: "t3code/1234abcd",
        expectedBranch: "t3code/1234abcd",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/generated-branch-name");
    await system.dispose();
  });

  it.each(["unlink", "relink", "branch", "worktree", "project", "delete"] as const)(
    "rejects PR discovery completed after a newer %s command",
    async (change) => {
      const system = await createOrchestrationSystem(undefined, {
        resolve: (workspaceRoot) =>
          Effect.succeed({
            canonicalKey: "example.test/owner/repository",
            provider: "github",
            displayName: "owner/repository",
            rootPath: workspaceRoot,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://example.test/owner/repository.git",
            },
          }),
      });
      // Same-tick links must replace the old PR, not rely on timestamp ordering.
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(now()));
      try {
        const projectId = ProjectId.make("pr-race-project");
        const threadId = ThreadId.make("pr-race-thread");
        const previous = {
          projectId,
          repository: "owner/repository",
          number: 1,
          url: "https://example.test/owner/repository/pull/1",
        };
        const replacement = {
          ...previous,
          number: 2,
          url: "https://example.test/owner/repository/pull/2",
        };
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("pr-race-project-create"),
            projectId,
            title: "PR race project",
            workspaceRoot: "/tmp/pr-race-project",
            defaultModelSelection: null,
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("pr-race-thread-create"),
            threadId,
            projectId,
            title: "PR race thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: null,
            createdAt: now(),
          }),
        );
        const observed = await system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("pr-race-link"),
            threadId,
            linkedPullRequest: previous,
          }),
        );
        expect((await system.readModel()).threads[0]?.linkedPullRequest).toEqual(previous);
        const metadataChanges = {
          unlink: { linkedPullRequest: null },
          relink: {
            linkedPullRequest: {
              ...previous,
              number: 3,
              url: "https://example.test/owner/repository/pull/3",
            },
          },
          branch: { branch: "another-feature" },
          worktree: { worktreePath: "/tmp/another-worktree" },
          project: {},
        };
        await system.run(
          system.engine.dispatch(
            change === "project"
              ? {
                  type: "project.meta.update",
                  commandId: CommandId.make("pr-race-project-move"),
                  projectId,
                  workspaceRoot: "/tmp/another-project-root",
                }
              : change === "delete"
                ? { type: "thread.delete", commandId: CommandId.make("pr-race-delete"), threadId }
                : {
                    type: "thread.meta.update",
                    commandId: CommandId.make(`pr-race-${change}`),
                    threadId,
                    ...metadataChanges[change],
                  },
          ),
        );
        const command = {
          type: "thread.pull-request.sync",
          commandId: CommandId.make("pr-race-stale-sync"),
          threadId,
          projectId,
          snapshotSequence: observed.sequence,
          expected: {
            workspaceRoot: "/tmp/pr-race-project",
            branch: "feature",
            worktreePath: null,
            linkedPullRequest: previous,
            branchPullRequest: null,
          },
          branchPullRequest: replacement,
          linkedPullRequest: replacement,
        } satisfies OrchestrationCommand;
        const error = await system.run(system.engine.dispatch(command).pipe(Effect.flip));
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        if (change === "delete") return;
        const current = (await system.readModel()).threads[0];
        expect(current?.branchPullRequest ?? null).toBeNull();
        expect(current?.pullRequests.map((link) => link.number)).toEqual(
          change === "unlink" ? [] : change === "relink" ? [3] : [1],
        );
        expect(current?.linkedPullRequest ?? null).toEqual(
          change === "unlink"
            ? null
            : change === "relink"
              ? metadataChanges.relink.linkedPullRequest
              : previous,
        );
      } finally {
        clock.mockRestore();
        await system.dispose();
      }
    },
  );

  it("saves PR associations through streaming and unrelated metadata edits", async () => {
    const system = await createOrchestrationSystem();
    try {
      const projectId = ProjectId.make("pr-sync-project");
      const threadId = ThreadId.make("pr-sync-thread");
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("pr-sync-project-create"),
          projectId,
          title: "PR sync project",
          workspaceRoot: "/tmp/pr-sync-project",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      const created = await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("pr-sync-thread-create"),
          threadId,
          projectId,
          title: "PR sync thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature",
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const reference = {
        projectId,
        repository: "owner/repository",
        number: 42,
        url: "https://example.test/owner/repository/pull/42",
      };
      const activityAt = "2026-01-01T01:00:00.000Z";
      await system.run(
        system.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("pr-sync-streaming-message"),
          threadId,
          messageId: MessageId.make("pr-sync-message"),
          delta: "The PR is ready.",
          createdAt: activityAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("pr-sync-title-and-model"),
          threadId,
          title: "Renamed thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("pr-sync-project-title"),
          projectId,
          title: "Renamed project",
        }),
      );
      const beforeSync = (await system.readModel()).threads[0];
      await system.run(
        system.engine.dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("pr-sync-discovery"),
          projectId,
          threadId,
          snapshotSequence: created.sequence,
          expected: {
            workspaceRoot: "/tmp/pr-sync-project",
            branch: "feature",
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: reference,
        }),
      );
      const current = (await system.readModel()).threads[0];
      expect(current?.branchPullRequest).toEqual(reference);
      expect(current?.linkedPullRequest ?? null).toBeNull();
      expect(current?.updatedAt).toBe(beforeSync?.updatedAt);
    } finally {
      await system.dispose();
    }
  });

  it("allows authoritative worktree bootstrap to assign a temporary branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-project-create"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Project",
        workspaceRoot: "/tmp/project-worktree-bootstrap",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-thread-create"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-authoritative-worktree-bootstrap"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/project-worktree-bootstrap-worktree",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/1234abcd");
    expect(snapshot.threads[0]?.worktreePath).toBe("/tmp/project-worktree-bootstrap-worktree");
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const runtime = ManagedRuntime.make(
      makeOrchestrationLayer(undefined, undefined, (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return true;
        }
        return false;
      }),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-atomic-create"),
        threadId: ThreadId.make("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failure",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles command state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventDeferred: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("already archived");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });

  it("replays the accepted receipt for a genuine retry of the same command", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-retry-project-create"),
        projectId: asProjectId("project-retry"),
        title: "Retry Project",
        workspaceRoot: "/tmp/project-retry",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-retry-thread-create"),
        threadId: ThreadId.make("thread-retry"),
        projectId: asProjectId("project-retry"),
        title: "retry",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStart = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-retry-turn-start"),
      threadId: ThreadId.make("thread-retry"),
      message: {
        messageId: asMessageId("msg-retry"),
        role: "user",
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    } as const;

    const first = await system.run(engine.dispatch(turnStart));
    const second = await system.run(engine.dispatch(turnStart));
    expect(second.sequence).toBe(first.sequence);

    const readModel = await system.readModel();
    const thread = readModel.threads.find((candidate) => candidate.id === "thread-retry");
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);

    await system.dispose();
  });

  it("rejects reusing an accepted command id for a different aggregate", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-conflict-project-create"),
        projectId: asProjectId("project-conflict"),
        title: "Conflict Project",
        workspaceRoot: "/tmp/project-conflict",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    for (const threadId of ["thread-conflict-a", "thread-conflict-b"]) {
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-${threadId}-create`),
          threadId: ThreadId.make(threadId),
          projectId: asProjectId("project-conflict"),
          title: threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
    }

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-conflict-turn-start"),
        threadId: ThreadId.make("thread-conflict-a"),
        message: {
          messageId: asMessageId("msg-conflict-a"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-conflict-turn-start"),
          threadId: ThreadId.make("thread-conflict-b"),
          message: {
            messageId: asMessageId("msg-conflict-b"),
            role: "user",
            text: "hello again",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      ),
    ).rejects.toThrow("already used for thread 'thread-conflict-a'");

    const readModel = await system.readModel();
    const targetThread = readModel.threads.find(
      (candidate) => candidate.id === "thread-conflict-b",
    );
    expect(targetThread?.messages.filter((message) => message.role === "user")).toHaveLength(0);

    await system.dispose();
  });

  it("stamps the dispatching client's origin onto persisted event metadata", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-origin-project-create"),
          projectId: asProjectId("project-origin"),
          title: "Origin Project",
          workspaceRoot: "/tmp/project-origin",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        },
        { origin: { surface: "mobile", appVersion: "1.2.3" } },
      ),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-no-origin-project-create"),
        projectId: asProjectId("project-no-origin"),
        title: "No Origin Project",
        workspaceRoot: "/tmp/project-no-origin",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    const withOrigin = events.find((event) => event.commandId === "cmd-origin-project-create");
    const withoutOrigin = events.find(
      (event) => event.commandId === "cmd-no-origin-project-create",
    );

    expect(withOrigin?.metadata.origin).toEqual({ surface: "mobile", appVersion: "1.2.3" });
    expect(withoutOrigin?.metadata.origin).toBeUndefined();

    await system.dispose();
  });
});

describe("atomic shared preparation acceptance", () => {
  const projectId = ProjectId.make("shared-preparation-project");
  const threadId = ThreadId.make("shared-preparation-thread");
  const first = {
    type: "thread.prompt.enqueue" as const,
    commandId: CommandId.make("shared-first"),
    threadId,
    createdAt: now(),
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    message: { messageId: MessageId.make("shared-first-message"), text: "First", attachments: [] },
    bootstrap: {
      createThread: {
        projectId,
        title: "Shared setup",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdAt: now(),
      },
      prepareWorktree: {
        projectCwd: "/tmp/shared-preparation",
        baseBranch: "main",
        branch: "feature/shared",
      },
      runSetupScript: true,
    },
  };
  const createProject = {
    type: "project.create" as const,
    commandId: CommandId.make("shared-project"),
    projectId,
    title: "Shared",
    workspaceRoot: "/tmp/shared-preparation",
    createdAt: now(),
  };
  it("rejects deletion atomically until required preparation has stopped", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      await system.run(system.engine.dispatch(first));
      const before = await system.run(system.engine.latestSequence);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.delete",
            projectId,
            force: true,
            commandId: CommandId.make("delete-project-pending"),
          }),
        ),
      ).rejects.toThrow("Setup must finish stopping");
      expect(await system.run(system.engine.latestSequence)).toBe(before);
      expect(Option.isSome(await system.readThread(threadId))).toBe(true);
      const setup = Option.getOrThrow(await system.readThread(threadId)).promptQueue!.preparation!;
      await system.run(
        system.engine.dispatch({
          type: "thread.preparation.update",
          commandId: CommandId.make("running-for-delete"),
          threadId,
          createdAt: now(),
          expectedRevision: setup.revision,
          preparation: { ...setup, revision: setup.revision + 1, state: "running", settled: false },
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.queue.pause",
          commandId: CommandId.make("pause-for-delete"),
          threadId,
          createdAt: now(),
        }),
      );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.delete",
            threadId,
            commandId: CommandId.make("delete-unsettled"),
          }),
        ),
      ).rejects.toThrow("Setup must finish stopping");
    } finally {
      await system.dispose();
    }
  });
  it("orders preflight rejection with duplicate deletes and keeps the original project scope", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      await system.run(system.engine.dispatch(first));
      await system.run(
        system.engine.dispatch({
          type: "thread.queue.pause",
          commandId: CommandId.make("stop-pending"),
          threadId,
          createdAt: now(),
        }),
      );
      const command = {
        type: "thread.delete" as const,
        threadId,
        commandId: CommandId.make("rejected-delete"),
      };
      await expect(
        system.run(
          system.engine.dispatch(command, {
            rejection: { projectId, detail: "Process exit was not confirmed" },
          }),
        ),
      ).rejects.toThrow("Process exit was not confirmed");
      await expect(system.run(system.engine.dispatch(command))).rejects.toThrow(
        "Process exit was not confirmed",
      );
      expect(Option.isSome(await system.readThread(threadId))).toBe(true);
      expect(Option.getOrThrow(await system.receipt(command.commandId)).projectId).toBe(projectId);
      const acceptedCommand = { ...command, commandId: CommandId.make("fresh-delete") };
      const accepted = await system.run(system.engine.dispatch(acceptedCommand));
      expect(
        await system.run(
          system.engine.dispatch(acceptedCommand, {
            rejection: { projectId, detail: "A late duplicate failed" },
          }),
        ),
      ).toEqual(accepted);
    } finally {
      await system.dispose();
    }
  });
  it("fences both preparatory Stop and final Delete from a retried preparation", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      await system.run(system.engine.dispatch(first));
      const options = {
        deletionPreconditions: {
          projectId,
          snapshotSequence: await system.run(system.engine.latestSequence),
          threads: [{ threadId, preparationAttemptId: first.commandId }],
        },
      };
      await system.run(
        system.engine.dispatch({
          type: "thread.queue.pause",
          threadId,
          commandId: CommandId.make("pause-retry"),
          createdAt: now(),
        }),
      );
      const queue = Option.getOrThrow(await system.readThread(threadId)).promptQueue!;
      await system.run(
        system.engine.dispatch({
          type: "thread.preparation.retry",
          threadId,
          commandId: CommandId.make("retry-before-delete"),
          createdAt: now(),
          expectedRevision: queue.preparation!.revision,
          expectedControlRevision: queue.revision,
        }),
      );
      for (const command of [
        {
          type: "thread.queue.pause" as const,
          threadId,
          commandId: CommandId.make("late-delete-stop"),
          createdAt: now(),
        },
        {
          type: "thread.delete" as const,
          threadId,
          commandId: CommandId.make("late-final-delete"),
        },
      ])
        await expect(system.run(system.engine.dispatch(command, options))).rejects.toThrow(
          "changed during deletion",
        );
      expect(
        Option.getOrThrow(await system.readThread(threadId)).promptQueue!.preparation!.state,
      ).toBe("pending");
    } finally {
      await system.dispose();
    }
  });
  it.each([false, true])(
    "does not retarget a recreated thread or its rejected receipt (different project: %s)",
    async (differentProject) => {
      const system = await createOrchestrationSystem();
      try {
        await system.run(system.engine.dispatch(createProject));
        const create = {
          type: "thread.create" as const,
          ...first.bootstrap.createThread,
          threadId,
          commandId: CommandId.make("old-create"),
        };
        await system.run(system.engine.dispatch(create));
        const options = {
          deletionPreconditions: {
            projectId,
            snapshotSequence: await system.run(system.engine.latestSequence),
            threads: [{ threadId, preparationAttemptId: null }],
          },
        };
        await system.run(
          system.engine.dispatch({
            type: "thread.delete",
            threadId,
            commandId: CommandId.make("other-delete"),
          }),
        );
        const replacementProject = differentProject
          ? ProjectId.make("replacement-project")
          : projectId;
        if (differentProject)
          await system.run(
            system.engine.dispatch({
              ...createProject,
              projectId: replacementProject,
              commandId: CommandId.make("replacement-project-create"),
              workspaceRoot: "/tmp/replacement-project",
            }),
          );
        const blockedCreate = {
          ...create,
          projectId: replacementProject,
          commandId: CommandId.make("blocked-replacement-create"),
        };
        await expect(system.run(system.engine.dispatch(blockedCreate))).rejects.toThrow(
          "not been confirmed stopped",
        );
        await system.run(
          system.engine.dispatch({
            ...create,
            threadId: ThreadId.make("unrelated-replacement"),
            commandId: CommandId.make("unrelated-replacement-create"),
          }),
        );
        await system.confirmDeletedThreadCleanup(threadId);
        await expect(system.run(system.engine.dispatch(blockedCreate))).rejects.toThrow(
          "not been confirmed stopped",
        );
        await system.run(
          system.engine.dispatch({
            ...create,
            projectId: replacementProject,
            commandId: CommandId.make("replacement-create"),
          }),
        );
        const stale = {
          type: "thread.delete" as const,
          threadId,
          commandId: CommandId.make("stale-delete"),
        };
        await expect(system.run(system.engine.dispatch(stale, options))).rejects.toThrow(
          "changed during deletion",
        );
        expect(Option.getOrThrow(await system.receipt(stale.commandId)).projectId).toBe(projectId);
        expect(Option.isSome(await system.readThread(threadId))).toBe(true);
      } finally {
        await system.dispose();
      }
    },
  );
  it("saves one receipt for creation, first prompt and setup, and replay cannot reorder teammate work", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      const accepted = await system.run(system.engine.dispatch(first));
      await system.run(
        system.engine.dispatch({
          ...first,
          commandId: CommandId.make("teammate"),
          bootstrap: undefined,
          message: {
            ...first.message,
            messageId: MessageId.make("teammate-message"),
            text: "Second",
          },
        }),
      );
      expect(await system.run(system.engine.dispatch(first))).toEqual(accepted);
      const thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.messages).toHaveLength(0);
      expect(thread.promptQueue?.preparation?.state).toBe("pending");
      expect((await system.readShell()).threads[0]?.promptQueueSummary?.preparation).toEqual({
        state: "pending",
        revision: 0,
        settled: true,
      });
      expect(thread.promptQueue?.entries.map((entry) => entry.messageId)).toEqual([
        "shared-first-message",
        "teammate-message",
      ]);
      const receipt = Option.getOrThrow(await system.receipt(first.commandId));
      expect(receipt.status).toBe("accepted");
      expect(receipt.projectId).toBe(projectId);
      expect(receipt.aggregateId).toBe(threadId);
      const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
      expect(
        events.filter((event) => event.commandId === first.commandId).map((event) => event.type),
      ).toEqual(["thread.created", "thread.prompt-queue-changed", "thread.prompt-queue-changed"]);
    } finally {
      await system.dispose();
    }
  });
  it("rolls back the thread, intent and queue together if the first prompt projection fails", async () => {
    let failed = false;
    const system = await createOrchestrationSystem(undefined, undefined, (event) => {
      if (
        !failed &&
        event.commandId === first.commandId &&
        event.type === "thread.prompt-queue-changed" &&
        event.payload.entry
      ) {
        failed = true;
        return true;
      }
      return false;
    });
    try {
      await system.run(system.engine.dispatch(createProject));
      await expect(system.run(system.engine.dispatch(first))).rejects.toThrow(
        "Injected preparation projection failure",
      );
      expect(Option.isNone(await system.readThread(threadId))).toBe(true);
      expect(Option.isNone(await system.receipt(first.commandId))).toBe(true);
      expect(
        (await system.run(Stream.runCollect(system.engine.readEvents(0)))).map(
          (event) => event.type,
        ),
      ).toEqual(["project.created"]);
      await system.run(system.engine.dispatch(first));
      expect(
        Option.getOrThrow(await system.readThread(threadId)).promptQueue?.entries,
      ).toHaveLength(1);
    } finally {
      await system.dispose();
    }
  });
  it("rejects invalid first prompts without creating a thread and retains an authorized receipt scope", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      const rejected = { ...first, message: { ...first.message, text: "" } };
      await expect(system.run(system.engine.dispatch(rejected))).rejects.toThrow("A prompt needs");
      expect(Option.isNone(await system.readThread(threadId))).toBe(true);
      const receipt = Option.getOrThrow(await system.receipt(first.commandId));
      expect(receipt.status).toBe("rejected");
      expect(receipt.projectId).toBe(projectId);
    } finally {
      await system.dispose();
    }
  });
});

describe("portable thread command fences", () => {
  it("keeps the moving thread protected from offline force deletion after releasing its checkout", async () => {
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("released-capture-project");
    const threadId = ThreadId.make("released-capture-thread");
    const root = "/tmp/released-capture-project";
    const owner = {
      projectId,
      threadId,
      operationId: "sealed-capture",
      environmentId: "local",
      generation: 1,
      relayUrl: "https://relay.example",
    };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("released-project"),
          projectId,
          title: "Project",
          workspaceRoot: root,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("released-thread"),
          threadId,
          projectId,
          title: "Moving",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const enrollment = { ...owner, operationId: "initial-enrollment" };
      await system.run(system.fence.prepare(enrollment));
      await system.run(system.fence.activate(enrollment));
      await system.run(
        system.fence.beginDrain({ ...owner, previousOperationId: enrollment.operationId }),
      );
      await system.run(system.fence.freeze(owner));
      const captures = makeCheckoutCapture(system.sql);
      await system.run(
        captures.acquireDrain({ ...owner, checkoutRoot: root, gitCommonRoot: `${root}/.git` }),
      );
      await system.run(captures.enterCapturing(owner));
      await system.run(
        captures.release(owner, { outcome: "sealed", manifestSha256: "c".repeat(64) }),
      );
      await system.run(
        system.engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("rename-released-project"),
          projectId,
          title: "Renamed",
        }),
      );
      for (const phase of ["frozen", "retired"] as const) {
        if (phase === "retired") await system.run(system.fence.retire(owner));
        const before = await system.run(system.engine.latestSequence);
        await expect(
          system.run(
            system.engine.dispatch({
              type: "project.delete",
              commandId: CommandId.make(`offline-delete-${phase}`),
              projectId,
              force: true,
            }),
          ),
        ).rejects.toMatchObject({ _tag: "ThreadExecutionFenceError" });
        expect(await system.run(system.engine.latestSequence)).toBe(before);
        expect(Option.getOrThrow(await system.readThread(threadId)).deletedAt).toBeNull();
      }
    } finally {
      await system.dispose();
    }
  });

  it("prevents a direct turn from bypassing a newly queued local move", async () => {
    const system = await createOrchestrationSystem(undefined, undefined, undefined, {
      getInstance: () =>
        Effect.succeed({ enabled: true, driverKind: "codex" } as unknown as ProviderInstance),
    });
    const projectId = ProjectId.make("local-queue-project");
    const threadId = ThreadId.make("local-queue-thread");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("local-project"),
          projectId,
          title: "Local",
          workspaceRoot: "/tmp/local-queue-project",
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("local-thread"),
          threadId,
          projectId,
          title: "Local",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const direct = {
        type: "thread.turn.start" as const,
        commandId: CommandId.make("legacy-local-turn"),
        threadId,
        message: {
          messageId: MessageId.make("legacy-local-message"),
          role: "user" as const,
          text: "Before VM move",
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: now(),
      };
      await system.run(system.engine.dispatch(direct, { directClientCommand: true }));
      // A stale client may have passed preflight before another client queues the move.
      await system.run(system.fence.assertDirectClientAllowed(threadId, "thread.turn.start"));
      await system.run(
        system.engine.dispatch({
          type: "thread.move.enqueue",
          commandId: CommandId.make("local-move"),
          threadId,
          messageId: MessageId.make("local-move"),
          destination: { kind: "vm" },
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch(
          {
            type: "thread.queue.pause",
            commandId: CommandId.make("pause-local-move"),
            threadId,
            createdAt: now(),
          },
          { directClientCommand: true },
        ),
      );
      const before = await system.run(system.engine.latestSequence);
      const stale = {
        ...direct,
        commandId: CommandId.make("bypass-local-move"),
        message: { ...direct.message, messageId: MessageId.make("bypass-local-message") },
      };
      await expect(
        system.run(system.engine.dispatch(stale, { directClientCommand: true })),
      ).rejects.toMatchObject({
        _tag: "ThreadExecutionFenceError",
        detail: expect.stringContaining("shared queue"),
      });
      expect(await system.run(system.engine.latestSequence)).toBe(before);
      expect(await system.run(system.fence.get(threadId))).toBeNull();
      const waiting = Option.getOrThrow(await system.readThread(threadId));
      expect(waiting.promptQueue?.enabled).toBe(false);
      expect(waiting.promptQueue?.entries.map((entry) => entry.messageId)).toEqual(["local-move"]);
      expect(waiting.messages.map((message) => message.id)).toEqual(["legacy-local-message"]);
      await system.run(
        system.engine.dispatch(
          {
            ...stale,
            type: "thread.prompt.enqueue",
            commandId: CommandId.make("queued-local-followup"),
          },
          { directClientCommand: true },
        ),
      );
      const queued = Option.getOrThrow(await system.readThread(threadId));
      expect(queued.promptQueue?.enabled).toBe(false);
      expect(queued.promptQueue?.entries.map((entry) => entry.messageId)).toEqual([
        "local-move",
        "bypass-local-message",
      ]);
      expect(queued.messages.map((message) => message.id)).toEqual(["legacy-local-message"]);
      const events = await system.run(Stream.runCollect(system.engine.readEvents(before)));
      expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(false);
    } finally {
      await system.dispose();
    }
  });

  it("blocks direct project deletion for active and draining portable threads while retaining local and trusted deletion", async () => {
    for (const phase of ["active", "draining"] as const) {
      const system = await createOrchestrationSystem();
      const create = async (suffix: string) => {
        const projectId = ProjectId.make(`project-delete-${phase}-${suffix}`);
        const threadId = ThreadId.make(`thread-delete-${phase}-${suffix}`);
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`create-${projectId}`),
            projectId,
            title: suffix,
            workspaceRoot: `/tmp/${projectId}`,
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${threadId}`),
            threadId,
            projectId,
            title: suffix,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now(),
          }),
        );
        return { projectId, threadId };
      };
      try {
        const portable = await create("portable");
        const owner = {
          ...portable,
          relayUrl: "https://relay.example",
          environmentId: "here",
          generation: 1,
          operationId: "enrollment",
        };
        await system.run(system.fence.prepare(owner));
        await system.run(system.fence.activate(owner));
        if (phase === "draining")
          await system.run(
            system.fence.beginDrain({
              ...owner,
              operationId: "move",
              previousOperationId: "enrollment",
            }),
          );
        const before = await system.run(system.engine.latestSequence);
        const source = await system.run(system.fence.get(portable.threadId));
        const command = {
          type: "project.delete" as const,
          projectId: portable.projectId,
          force: true,
          commandId: CommandId.make(`direct-delete-${phase}`),
        };
        await expect(
          system.run(system.engine.dispatch(command, { directClientCommand: true })),
        ).rejects.toMatchObject({
          _tag: "ThreadExecutionFenceError",
          detail: expect.stringContaining("managed threads through Launchpad Connect"),
        });
        expect(await system.run(system.engine.latestSequence)).toBe(before);
        expect(await system.run(system.fence.get(portable.threadId))).toEqual(source);
        expect(Option.getOrThrow(await system.readThread(portable.threadId)).deletedAt).toBeNull();
        expect(Option.isNone(await system.receipt(command.commandId))).toBe(true);
        const local = await create("local");
        await system.run(
          system.engine.dispatch(
            {
              type: "project.delete",
              projectId: local.projectId,
              force: true,
              commandId: CommandId.make(`local-delete-${phase}`),
            },
            { directClientCommand: true },
          ),
        );
        expect(Option.isNone(await system.readThread(local.threadId))).toBe(true);
        await system.run(
          system.engine.dispatch({
            ...command,
            commandId: CommandId.make(`trusted-delete-${phase}`),
          }),
        );
        expect(Option.isNone(await system.readThread(portable.threadId))).toBe(true);
      } finally {
        await system.dispose();
      }
    }
  });

  it("keeps a frozen thread immutable across restart without rejecting its queued command permanently", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-portable-fence-"));
    const database = NodePath.join(directory, "state.sqlite");
    let system = await createOrchestrationSystem(database);
    const projectId = ProjectId.make("portable-project");
    const threadId = ThreadId.make("portable-thread");
    const enrollment = {
      threadId,
      projectId,
      relayUrl: "https://relay.example",
      environmentId: "here",
      generation: 1,
      operationId: "enroll",
    };
    const move = { ...enrollment, operationId: "move", previousOperationId: "enroll" };
    const update = {
      type: "thread.meta.update" as const,
      commandId: CommandId.make("pending-update"),
      threadId,
      title: "After abort",
    };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("portable-project-create"),
          projectId,
          title: "Portable",
          workspaceRoot: directory,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("portable-thread-create"),
          threadId,
          projectId,
          title: "Original",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await system.run(system.fence.prepare(enrollment));
      await system.run(system.fence.activate(enrollment));
      await expect(
        system.run(system.engine.dispatch(update, { directClientCommand: true })),
      ).rejects.toMatchObject({ _tag: "ThreadExecutionFenceError" });
      expect(Option.isNone(await system.receipt(update.commandId))).toBe(true);
      await system.run(system.fence.beginDrain(move));
      const cursor = await system.run(system.fence.freeze(move));
      await system.dispose();
      system = await createOrchestrationSystem(database);
      await expect(system.run(system.engine.dispatch(update))).rejects.toMatchObject({
        _tag: "ThreadExecutionFenceError",
      });
      expect(Option.isNone(await system.receipt(update.commandId))).toBe(true);
      await expect(
        system.run(
          system.engine.dispatch(update, {
            rejection: { projectId, detail: "preflight denied" },
          }),
        ),
      ).rejects.toMatchObject({ _tag: "ThreadExecutionFenceError" });
      expect(Option.isNone(await system.receipt(update.commandId))).toBe(true);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.delete",
            commandId: CommandId.make("delete-held-project"),
            projectId,
            force: true,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "ThreadExecutionFenceError" });
      expect(await system.run(system.engine.latestSequence)).toBe(cursor);
      expect(Option.getOrThrow(await system.readThread(threadId)).title).toBe("Original");
      // The relay has now confirmed cancellation and destination removal.
      await system.run(system.fence.activate(move));
      await system.run(system.engine.dispatch(update));
      expect(Option.getOrThrow(await system.readThread(threadId)).title).toBe("After abort");
      const receipt = await system.receipt(update.commandId);
      expect(Option.isSome(receipt) && receipt.value.status).toBe("accepted");
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeBaselineReceipt = Schema.decodeUnknownSync(OrchestrationCommandReceipt);
const baselineDigest = <A>(rows: ReadonlyArray<A>, encode: (row: A) => string) => {
  const bytes = new TextEncoder().encode(rows.map((row) => `${encode(row)}\n`).join(""));
  return {
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
};
const sealBaseline = (input: ThreadHistoryBaselineInput): ThreadHistoryBaselineInput => ({
  ...input,
  source: {
    ...input.source,
    eventCount: input.events.length,
    receiptCount: input.receipts.length,
    sourceSequence: input.events.at(-1)!.sequence,
    events: baselineDigest(input.events, Schema.encodeSync(Schema.fromJsonString(EventSchema))),
    receipts: baselineDigest(
      input.receipts,
      Schema.encodeSync(Schema.fromJsonString(OrchestrationCommandReceipt)),
    ),
  },
});
async function baselineFixture(
  rejectProjection?: (event: OrchestrationEvent) => boolean,
  databasePath?: string,
) {
  const system = await createOrchestrationSystem(databasePath, undefined, rejectProjection);
  const projectId = ProjectId.make("baseline-destination-project");
  const threadId = ThreadId.make("baseline-thread");
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("baseline-project"),
      projectId,
      title: "Destination",
      workspaceRoot: "/tmp/baseline-destination",
      createdAt: now(),
    }),
  );
  const destination = {
    threadId,
    projectId,
    environmentId: "destination",
    relayUrl: "https://relay.example",
    generation: 2,
    operationId: "baseline-move",
    branch: "main",
    worktreePath: "/tmp/baseline-checkout",
  };
  await system.run(system.fence.prepare(destination));
  const decode = Schema.decodeUnknownSync(EventSchema);
  const event = (index: number): OrchestrationEvent =>
    decode({
      type: index === 0 ? "thread.created" : "thread.message-sent",
      sequence: 100 + index * 5,
      eventId: `baseline-event-${index}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: now(),
      commandId: `baseline-command-${index}`,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload:
        index === 0
          ? {
              threadId,
              projectId: "source-project",
              title: "Moved history",
              modelSelection: { instanceId: "codex", model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: "/original/path",
              createdAt: now(),
              updatedAt: now(),
            }
          : {
              threadId,
              messageId: `baseline-message-${index}`,
              role: "user",
              text: `Original message ${index}`,
              author: { userId: "alice", displayName: "Alice", imageUrl: null },
              turnId: null,
              streaming: false,
              createdAt: now(),
              updatedAt: now(),
            },
    });
  const receipts = ["accepted", "rejected"].map((status) =>
    decodeBaselineReceipt({
      commandId: `baseline-${status}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      projectId: "source-project",
      acceptedAt: now(),
      resultSequence: 999,
      status,
      error: status === "rejected" ? "Original rejection" : null,
    }),
  );
  const input = sealBaseline({
    version: 1,
    manifestSha256: "a".repeat(64),
    source: {
      format: "launchpad-history-v1",
      threadId,
      environmentId: "source",
      generation: 1,
      operationId: destination.operationId,
      sourceSequence: 0,
      eventCount: 0,
      receiptCount: 0,
      events: { sha256: "a".repeat(64), size: 0 },
      receipts: { sha256: "a".repeat(64), size: 0 },
    },
    destination,
    events: Array.from({ length: 4 }, (_, index) => event(index)),
    receipts,
    importedAt: now(),
  });
  return { system, input, threadId, projectId };
}
describe("portable thread baseline import", () => {
  it("imports authors and complete history with local sequences, publishes only the boundary, and deduplicates old commands", async () => {
    const f = await baselineFixture();
    try {
      const result = await f.system.importedEvents(f.input);
      expect(result.events.map((event) => event.type)).toEqual(["thread.placement-imported"]);
      const mirrored: OrchestrationEvent[] = [];
      await f.system.run(
        makeThreadHistorySync(f.system.sql, f.system.engine, {
          append: (_owner, event) =>
            Effect.sync(() => {
              mirrored.push(event);
            }),
          confirmThrough: () => Effect.void,
        }).synchronize(f.threadId),
      );
      expect(mirrored.map((event) => event.type)).toEqual(["thread.placement-imported"]);
      expect(mirrored[0]?.eventId).toBe(result.events[0]?.eventId);
      const thread = Option.getOrThrow(await f.system.readThread(f.threadId));
      expect(thread.projectId).toBe(f.projectId);
      expect(thread.worktreePath).toBe(f.input.destination.worktreePath);
      expect(thread.messages.map((message) => message.author?.displayName)).toEqual([
        "Alice",
        "Alice",
        "Alice",
      ]);
      const stored = await f.system.run(
        Stream.runCollect(
          f.system.engine.readThreadEvents({
            threadId: f.threadId,
            fromSequenceExclusive: 0,
            toSequenceInclusive: result.result.sequence,
            limit: 100,
          }),
        ),
      );
      expect(stored.slice(0, 4).map((event) => event.eventId)).toEqual(
        f.input.events.map((event) => event.eventId),
      );
      expect(stored[0]!.sequence).not.toBe(f.input.events[0]!.sequence);
      const duplicate = {
        type: "thread.meta.update" as const,
        commandId: CommandId.make("baseline-accepted"),
        threadId: f.threadId,
        title: "Must not run",
      };
      expect(await f.system.run(f.system.engine.dispatch(duplicate))).toEqual(result.result);
      await expect(
        f.system.run(
          f.system.engine.dispatch({
            ...duplicate,
            commandId: CommandId.make("baseline-rejected"),
          }),
        ),
      ).rejects.toThrow("Original rejection");
      expect(Option.getOrThrow(await f.system.readThread(f.threadId)).title).toBe("Moved history");
      await expect(
        f.system.run(
          f.system.engine.dispatch({
            ...duplicate,
            commandId: CommandId.make("new-before-activation"),
          }),
        ),
      ).rejects.toThrow();
      expect((await f.system.run(f.system.fence.get(f.threadId)))?.phase).toBe("frozen");
      await f.system.run(f.system.fence.activate(f.input.destination));
      await f.system.run(
        f.system.engine.dispatch({
          ...duplicate,
          commandId: CommandId.make("after-activation"),
          title: "Runs once",
        }),
      );
      expect(Option.getOrThrow(await f.system.readThread(f.threadId)).title).toBe("Runs once");
    } finally {
      await f.system.dispose();
    }
  });
  it("retries an imported baseline without duplicating history and rejects a changed archive", async () => {
    const f = await baselineFixture();
    try {
      const first = await f.system.importBaseline(f.input);
      expect(await f.system.importBaseline(f.input)).toEqual(first);
      await expect(
        f.system.importBaseline({ ...f.input, manifestSha256: "b".repeat(64) }),
      ).rejects.toThrow("different archive");
      await expect(
        f.system.importBaseline({ ...f.input, events: f.input.events.slice(0, -1) }),
      ).rejects.toThrow("incomplete");
      expect(Option.getOrThrow(await f.system.readThread(f.threadId)).messages).toHaveLength(3);
    } finally {
      await f.system.dispose();
    }
  });
  it("rolls back every event, projection and receipt if the final projection fails", async () => {
    const f = await baselineFixture((event) => event.type === "thread.placement-imported");
    try {
      await expect(f.system.importBaseline(f.input)).rejects.toThrow("destination remains frozen");
      expect(Option.isNone(await f.system.readThread(f.threadId))).toBe(true);
      expect(Option.isNone(await f.system.receipt(CommandId.make("baseline-accepted")))).toBe(true);
      expect(await f.system.run(f.system.engine.latestSequence)).toBe(1);
      expect((await f.system.run(f.system.fence.get(f.threadId)))?.phase).toBe("frozen");
    } finally {
      await f.system.dispose();
    }
  });
  it("rejects modified content, foreign events and command receipt collisions", async () => {
    const f = await baselineFixture();
    try {
      await expect(
        f.system.importBaseline({
          ...f.input,
          events: f.input.events.map((event) => ({
            ...event,
            occurredAt: "2026-02-01T00:00:00.000Z",
          })),
        }),
      ).rejects.toThrow("manifest");
      const foreign = sealBaseline({
        ...f.input,
        events: f.input.events.map((event, index) =>
          index === 1 ? { ...event, aggregateId: ThreadId.make("foreign") } : event,
        ),
      });
      await expect(f.system.importBaseline(foreign)).rejects.toThrow("crosses a thread");
      const receiptCollision = sealBaseline({
        ...f.input,
        receipts: [
          { ...f.input.receipts[0]!, commandId: CommandId.make("baseline-project") },
          f.input.receipts[1]!,
        ],
      });
      await expect(f.system.importBaseline(receiptCollision)).rejects.toThrow(
        "conflicts with an existing receipt",
      );
      expect(Option.isNone(await f.system.readThread(f.threadId))).toBe(true);
    } finally {
      await f.system.dispose();
    }
  });
});

describe("portable thread baseline recovery", () => {
  it("imports only new history on a return move and refuses a divergent prefix", async () => {
    const f = await baselineFixture();
    try {
      const first = await f.system.importBaseline(f.input);
      const inherited = await f.system.run(
        Stream.runCollect(
          f.system.engine.readThreadEvents({
            threadId: f.threadId,
            fromSequenceExclusive: 0,
            toSequenceInclusive: first.sequence,
            limit: 100,
          }),
        ),
      );
      await f.system.run(f.system.fence.retire(f.input.destination));
      const destination = {
        ...f.input.destination,
        generation: 4,
        operationId: "return-move",
        worktreePath: "/tmp/return-checkout",
      };
      await f.system.run(f.system.fence.prepare(destination));
      const priorMessage = f.input.events[1]!;
      if (priorMessage.type !== "thread.message-sent") throw new Error("message fixture");
      const input = sealBaseline({
        ...f.input,
        manifestSha256: "b".repeat(64),
        destination,
        source: { ...f.input.source, generation: 3, operationId: destination.operationId },
        events: [
          ...inherited,
          {
            ...priorMessage,
            sequence: 1000,
            eventId: EventId.make("return-message-event"),
            payload: {
              ...priorMessage.payload,
              messageId: MessageId.make("return-message"),
              text: "Written on Linux",
            },
          },
        ],
      });
      const divergent = sealBaseline({
        ...input,
        events: input.events.map((event, index) =>
          index === 0 ? { ...event, occurredAt: "2026-02-01T00:00:00.000Z" } : event,
        ),
      });
      await expect(f.system.importBaseline(divergent)).rejects.toThrow("diverged");
      const result = await f.system.importBaseline(input);
      const thread = Option.getOrThrow(await f.system.readThread(f.threadId));
      expect(thread.messages).toHaveLength(4);
      expect(thread.messages.at(-1)?.text).toBe("Written on Linux");
      expect(thread.worktreePath).toBe("/tmp/return-checkout");
      const all = await f.system.run(
        Stream.runCollect(
          f.system.engine.readThreadEvents({
            threadId: f.threadId,
            fromSequenceExclusive: 0,
            toSequenceInclusive: result.sequence,
            limit: 100,
          }),
        ),
      );
      expect(all).toHaveLength(7);
      expect(new Set(all.map((event) => event.eventId)).size).toBe(7);
      expect(
        (
          await f.system.run(
            f.system.engine.getThreadReplayStats({
              threadId: f.threadId,
              fromSequenceExclusive: first.sequence,
              toSequenceInclusive: result.sequence,
              maxEvents: 100,
            }),
          )
        ).hasCreateEvent,
      ).toBe(true);
    } finally {
      await f.system.dispose();
    }
  });
  it("retains imported history, frozen ownership and repeat-import receipts across restart", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-baseline-restart-"));
    const databasePath = NodePath.join(directory, "state.sqlite");
    const f = await baselineFixture(undefined, databasePath);
    let system = f.system;
    try {
      const result = await system.importBaseline(f.input);
      await system.dispose();
      system = await createOrchestrationSystem(databasePath);
      expect(await system.importBaseline(f.input)).toEqual(result);
      const thread = Option.getOrThrow(await system.readThread(f.threadId));
      expect(thread.projectId).toBe(f.projectId);
      expect(thread.messages).toHaveLength(3);
      expect((await system.run(system.fence.get(f.threadId)))?.phase).toBe("frozen");
      expect(
        Option.getOrThrow(await system.receipt(CommandId.make("baseline-accepted"))).resultSequence,
      ).toBe(result.sequence);
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("protects another thread's message when an archive reuses its message ID", async () => {
    const f = await baselineFixture();
    try {
      const foreign = ThreadId.make("other-thread");
      await f.system.run(
        f.system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("other-create"),
          threadId: foreign,
          projectId: f.projectId,
          title: "Other",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await f.system.run(
        f.system.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("other-message"),
          threadId: foreign,
          messageId: MessageId.make("baseline-message-1"),
          delta: "Belongs to another thread",
          createdAt: now(),
        }),
      );
      await expect(f.system.importBaseline(f.input)).rejects.toThrow("another destination thread");
      expect(Option.isNone(await f.system.readThread(f.threadId))).toBe(true);
      expect(Option.getOrThrow(await f.system.readThread(foreign)).messages[0]?.text).toBe(
        "Belongs to another thread",
      );
    } finally {
      await f.system.dispose();
    }
  });
});

it("keeps transferred historical attachments when projections are rebuilt", async () => {
  const f = await baselineFixture();
  try {
    const attachmentDirectory = await f.system.attachmentDirectory();
    const attachmentId = `${f.threadId}-00000000-0000-4000-8000-000000000001`;
    await NodeFSP.mkdir(attachmentDirectory, { recursive: true });
    const file = NodePath.join(attachmentDirectory, `${attachmentId}.png`);
    await NodeFSP.writeFile(file, "historical file");
    const event = f.input.events[1]!;
    if (event.type !== "thread.message-sent") throw new Error("message fixture");
    const input = sealBaseline({
      ...f.input,
      events: [
        f.input.events[0]!,
        {
          ...event,
          payload: {
            ...event.payload,
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "history.png",
                mimeType: "image/png",
                sizeBytes: 15,
              },
            ],
          },
        },
        {
          ...event,
          sequence: 150,
          eventId: EventId.make("old-revert"),
          type: "thread.reverted",
          payload: { threadId: f.threadId, turnCount: 0 },
        },
      ],
    });
    await f.system.importBaseline(input);
    expect(Option.getOrThrow(await f.system.readThread(f.threadId)).messages).toHaveLength(0);
    await f.system.rebuildProjections();
    expect(await NodeFSP.readFile(file, "utf8")).toBe("historical file");
    expect(Option.getOrThrow(await f.system.readThread(f.threadId)).projectId).toBe(f.projectId);
  } finally {
    await f.system.dispose();
  }
});

it("moves an authored pending prompt between two real engine databases without re-enqueuing it", async () => {
  const f = await baselineFixture();
  const destination = await createOrchestrationSystem();
  try {
    await f.system.importBaseline(f.input);
    await f.system.run(f.system.fence.activate(f.input.destination));
    const command = {
      type: "thread.prompt.enqueue" as const,
      commandId: CommandId.make("queued-move-command"),
      threadId: f.threadId,
      message: {
        messageId: MessageId.make("queued-move-message"),
        text: "Run after the move",
        attachments: [],
      },
      author: { userId: "bob", displayName: "Bob", imageUrl: null },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: now(),
    };
    await f.system.run(f.system.engine.dispatch(command));
    const head = await f.system.run(f.system.engine.latestSequence);
    const history = await f.system.run(
      Stream.runCollect(
        f.system.engine.readThreadEvents({
          threadId: f.threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: head,
          limit: 100,
        }),
      ),
    );
    const owner = {
      ...f.input.destination,
      operationId: "second-real-engine-move",
      environmentId: "second-environment",
      generation: 3,
    };
    await destination.run(
      destination.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("destination-create-project"),
        projectId: f.projectId,
        title: "Other machine",
        workspaceRoot: "/tmp/other-machine",
        createdAt: now(),
      }),
    );
    await destination.run(destination.fence.prepare(owner));
    const receipts = await Promise.all(
      [...f.input.receipts.map((receipt) => receipt.commandId), command.commandId].map((id) =>
        f.system.receipt(id),
      ),
    );
    const input = sealBaseline({
      ...f.input,
      destination: owner,
      source: {
        ...f.input.source,
        environmentId: "destination",
        generation: 2,
        operationId: owner.operationId,
      },
      events: history,
      receipts: receipts.map(Option.getOrThrow),
    });
    const imported = await destination.importBaseline(input);
    expect(await destination.run(destination.engine.dispatch(command))).toEqual(imported);
    const queue = Option.getOrThrow(await destination.readThread(f.threadId)).promptQueue;
    expect(queue?.entries).toHaveLength(1);
    expect(queue?.entries[0]?.author?.displayName).toBe("Bob");
    expect(queue?.entries[0]?.messageId).toBe(command.message.messageId);
    expect((await destination.run(destination.fence.get(f.threadId)))?.phase).toBe("frozen");
  } finally {
    await destination.dispose();
    await f.system.dispose();
  }
});

it("activates a moved checkout only after matching files and history are installed", async () => {
  const f = await baselineFixture();
  const target = f.input.destination;
  const setPhase = (phase: string) =>
    f.system.run(
      Effect.gen(function* () {
        const sql = f.system.sql;
        yield* sql`UPDATE thread_checkout_claims SET phase = ${phase} WHERE operation_id = ${target.operationId}`;
      }),
    );
  try {
    await f.system.run(
      Effect.gen(function* () {
        const sql = f.system.sql;
        yield* sql`INSERT INTO thread_checkout_claims
        (operation_id, thread_id, generation, project_id, repository_root, checkout_path, mode, branch,
        manifest_sha256, workspace_sha256, inspection_json, phase) VALUES (${target.operationId}, ${target.threadId},
        ${target.generation}, ${target.projectId}, '/tmp/baseline-destination', ${target.worktreePath},
        'worktree', ${target.branch}, ${f.input.manifestSha256}, ${"b".repeat(64)}, 'null', 'reserved')`;
        yield* sql`INSERT INTO thread_checkout_claim_projects (operation_id, project_id)
        VALUES (${target.operationId}, ${target.projectId})`;
      }),
    );
    await expect(f.system.importBaseline(f.input)).rejects.toThrow("installed checkout");
    await expect(f.system.run(f.system.fence.activate(target))).rejects.toThrow(
      "installation must finish",
    );
    await setPhase("installed");
    await expect(f.system.run(f.system.fence.activate(target))).rejects.toThrow(
      "installation must finish",
    );
    await expect(
      f.system.importBaseline({
        ...f.input,
        destination: { ...target, worktreePath: "/wrong/checkout" },
      }),
    ).rejects.toThrow("installed checkout");
    await f.system.importBaseline(f.input);
    await expect(f.system.run(f.system.fence.activate(target))).rejects.toThrow(
      "Destination setup",
    );
    // The setup worker is exercised separately against real checkout files. Here
    // inject its durable receipt to prove activation reads it atomically.
    await f.system.run(
      Effect.gen(function* () {
        const sql = f.system.sql;
        yield* sql`UPDATE thread_transfer_baselines SET native_runtime_json = 'null' WHERE operation_id = ${target.operationId}`;
        yield* sql`INSERT INTO thread_transfer_readiness (operation_id, manifest_sha256, native_runtime_json, setup_sha256, phase)
        VALUES (${target.operationId}, ${f.input.manifestSha256}, 'null', ${"c".repeat(64)}, 'started')`;
      }),
    );
    await expect(f.system.run(f.system.fence.activate(target))).rejects.toThrow(
      "Destination setup",
    );
    await f.system.run(
      Effect.gen(function* () {
        const sql = f.system.sql;
        yield* sql`UPDATE thread_transfer_readiness SET phase = 'ready' WHERE operation_id = ${target.operationId}`;
      }),
    );
    await f.system.run(f.system.fence.activate(target));
    expect(
      await f.system.run(
        Effect.gen(function* () {
          const sql = f.system.sql;
          return yield* sql`SELECT phase FROM thread_checkout_claims WHERE operation_id = ${target.operationId}`;
        }),
      ),
    ).toEqual([{ phase: "released" }]);
    await f.system.run(
      f.system.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("after-checkout-activation"),
        threadId: f.threadId,
        title: "Running at destination",
      }),
    );
    expect(Option.getOrThrow(await f.system.readThread(f.threadId)).title).toBe(
      "Running at destination",
    );
  } finally {
    await f.system.dispose();
  }
});

it("commits native continuation with the baseline and rejects a changed cursor on retry", async () => {
  const f = await baselineFixture();
  try {
    const nativeRuntime = {
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: "native-thread",
      resumePolicy: "require-existing" as const,
      portableStateId: "c".repeat(64),
    };
    const input = { ...f.input, nativeRuntime };
    const first = await f.system.importBaseline(input);
    expect(await f.system.importBaseline(input)).toEqual(first);
    const rows = await f.system.run(f.system.sql<{
      cursor: string;
      status: string;
    }>`SELECT resume_cursor_json AS cursor, status
      FROM provider_session_runtime WHERE thread_id = ${f.threadId}`);
    expect(decodeUnknownJson(rows[0]!.cursor)).toEqual({
      threadId: nativeRuntime.threadId,
      resumePolicy: "require-existing",
      portableStateId: nativeRuntime.portableStateId,
    });
    expect(rows[0]!.status).toBe("stopped");
    await expect(
      f.system.importBaseline({
        ...input,
        nativeRuntime: { ...nativeRuntime, portableStateId: "d".repeat(64) },
      }),
    ).rejects.toThrow("different archive");
    await expect(f.system.importBaseline(f.input)).rejects.toThrow("different archive");
    expect((await f.system.run(f.system.fence.get(f.threadId)))?.phase).toBe("frozen");
  } finally {
    await f.system.dispose();
  }
});
it("rolls native installation and history back together when the completion receipt fails", async () => {
  const f = await baselineFixture();
  try {
    await f.system.run(f.system
      .sql`CREATE TRIGGER fail_transfer_receipt BEFORE INSERT ON thread_transfer_baselines
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`);
    await expect(
      f.system.importBaseline({
        ...f.input,
        nativeRuntime: {
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId: "native-thread",
          resumePolicy: "require-existing",
          portableStateId: "c".repeat(64),
        },
      }),
    ).rejects.toThrow();
    expect(
      await f.system.run(
        f.system.sql`SELECT 1 FROM provider_session_runtime WHERE thread_id = ${f.threadId}`,
      ),
    ).toHaveLength(0);
    expect(Option.isNone(await f.system.readThread(f.threadId))).toBe(true);
    expect((await f.system.run(f.system.fence.get(f.threadId)))?.phase).toBe("frozen");
  } finally {
    await f.system.dispose();
  }
});

describe("queued move provider admission", () => {
  effectIt.effect(
    "accepts default VM and named normal moves but rejects incompatible VM events before commit",
    () => {
      const provider = (driverKind: string) =>
        ({
          enabled: true,
          driverKind,
        }) as unknown as ProviderInstance;
      const registry: ProviderInstanceRegistry["Service"] = {
        getInstance: (id) =>
          Effect.succeed(
            provider(id === "codex" || id === "custom-codex" ? "codex" : "claudeAgent"),
          ),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.die("unused"),
      };
      const layer = makeOrchestrationLayer().pipe(
        Layer.provideMerge(Layer.succeed(ProviderInstanceRegistry, registry)),
      );
      const projectId = ProjectId.make("queue-provider-project");
      const threadId = ThreadId.make("queue-provider-thread");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("queue-provider-project"),
          projectId,
          title: "Test",
          workspaceRoot: "/tmp/queue-provider",
          createdAt: now(),
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("queue-provider-thread"),
          threadId,
          projectId,
          title: "Test",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        });
        yield* engine.dispatch({
          type: "thread.move.enqueue",
          commandId: CommandId.make("to-vm"),
          threadId,
          messageId: MessageId.make("move"),
          destination: { kind: "vm" },
          createdAt: now(),
        });
        const invalid = yield* Effect.result(
          engine.dispatch({
            type: "thread.prompt.enqueue",
            commandId: CommandId.make("bad-prompt"),
            threadId,
            message: { messageId: MessageId.make("bad"), text: "run", attachments: [] },
            modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now(),
          }),
        );
        expect(invalid._tag).toBe("Failure");
        const detail = yield* Effect.flatMap(ProjectionSnapshotQuery, (query) =>
          query.getThreadDetailById(threadId),
        );
        expect(
          Option.isSome(detail)
            ? detail.value.promptQueue?.entries.map((entry) => entry.messageId)
            : [],
        ).toEqual(["move"]);
        const destination = {
          kind: "environment" as const,
          environmentId: EnvironmentId.make("normal-target"),
          projectId,
        };
        const localMove = yield* engine.dispatch({
          type: "thread.move.enqueue",
          commandId: CommandId.make("leave-vm"),
          threadId,
          messageId: MessageId.make("leave-vm"),
          destination,
          createdAt: now(),
        });
        const namedPrompt = yield* engine.dispatch({
          type: "thread.prompt.enqueue",
          commandId: CommandId.make("named-after-local"),
          threadId,
          message: { messageId: MessageId.make("named-after-local"), text: "run", attachments: [] },
          modelSelection: { instanceId: ProviderInstanceId.make("custom-codex"), model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now(),
        });
        const currentQueue = yield* Effect.flatMap(ProjectionSnapshotQuery, (query) =>
          query.getThreadDetailById(threadId),
        );
        for (const command of [
          {
            type: "thread.queue.reorder",
            commandId: CommandId.make("named-before-leave-vm"),
            threadId,
            expectedRevision: Option.getOrThrow(currentQueue).promptQueue?.revision ?? -1,
            order: [
              MessageId.make("move"),
              MessageId.make("named-after-local"),
              MessageId.make("leave-vm"),
            ],
            createdAt: now(),
          },
          {
            type: "thread.meta.update",
            commandId: CommandId.make("named-vm-model"),
            threadId,
            modelSelection: { instanceId: ProviderInstanceId.make("custom-codex"), model: "test" },
          },
        ] satisfies OrchestrationCommand[]) {
          expect(yield* Effect.flip(engine.dispatch(command))).toMatchObject({
            _tag: "OrchestrationCommandInvariantError",
            detail: "Private VMs currently require the default Codex provider.",
          });
        }
        expect(yield* Stream.runCollect(engine.readEvents(namedPrompt.sequence))).toEqual([]);
        expect(localMove.sequence).toBeLessThan(namedPrompt.sequence);

        const namedThreadId = ThreadId.make("named-provider-thread");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("named-provider-thread"),
          threadId: namedThreadId,
          projectId,
          title: "Named Codex",
          modelSelection: { instanceId: ProviderInstanceId.make("custom-codex"), model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        });
        const accepted = yield* engine.dispatch({
          type: "thread.move.enqueue",
          commandId: CommandId.make("named-normal-move"),
          threadId: namedThreadId,
          messageId: MessageId.make("named-normal-move"),
          destination,
          createdAt: now(),
        });
        for (const command of [
          {
            type: "thread.move.enqueue",
            commandId: CommandId.make("named-vm-move"),
            threadId: namedThreadId,
            messageId: MessageId.make("named-vm-move"),
            destination: { kind: "vm" },
            createdAt: now(),
          },
          {
            type: "thread.move.edit",
            commandId: CommandId.make("named-vm-edit"),
            threadId: namedThreadId,
            messageId: MessageId.make("named-normal-move"),
            expectedRevision: 1,
            destination: { kind: "vm" },
            createdAt: now(),
          },
        ] satisfies OrchestrationCommand[]) {
          expect(yield* Effect.flip(engine.dispatch(command))).toMatchObject({
            _tag: "OrchestrationCommandInvariantError",
            detail: "Private VMs currently require the default Codex provider.",
          });
        }
        // No accepted event can reach the move worker, quota admission or allocation.
        expect(yield* Stream.runCollect(engine.readEvents(accepted.sequence))).toEqual([]);
        const namedDetail = yield* Effect.flatMap(ProjectionSnapshotQuery, (query) =>
          query.getThreadDetailById(namedThreadId),
        );
        expect(
          Option.isSome(namedDetail)
            ? namedDetail.value.promptQueue?.entries.map((entry) => [
                entry.messageId,
                entry.kind === "move" ? entry.destination.kind : entry.kind,
              ])
            : [],
        ).toEqual([["named-normal-move", "environment"]]);
      }).pipe(Effect.provide(layer));
    },
  );
});
