import { assert, describe, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import type { InstalledThreadVm } from "../relay/ThreadVmEnrollment.ts";
import { makeThreadVmRepositoryAccess } from "./ThreadVmRepositoryAccess.ts";

const vm: InstalledThreadVm = {
  operationId: "operation",
  environmentId: EnvironmentId.make("environment"),
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: "repository",
    generation: 1,
  },
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  environmentCredential: "narrow-test-credential",
  cloudMintPublicKey: "key",
};
const receipt: RelayThreadVmSetupReceipt = {
  version: 1,
  operationId: vm.operationId,
  environmentId: vm.environmentId,
  scope: vm.scope,
  projectId: ProjectId.make("vm:thread"),
  workspaceRoot: "/workspace/project",
  revision: "a".repeat(40),
  sequence: 2,
  execution: "frozen",
};
const owner = { user: { userId: "owner", displayName: "Owner", imageUrl: null } };
const grant = {
  environmentId: vm.environmentId,
  threadId: vm.scope.threadId,
  projectId: receipt.projectId,
  repositoryId: vm.scope.repositoryId,
  generation: 1,
  userId: owner.user.userId,
};
const fixture = () => {
  const calls: string[] = [];
  let response: Effect.Effect<Response> = Effect.sync(() => Response.json(grant));
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(vm.environmentId),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            calls.push(request.url);
            assert.equal(request.headers.authorization, `Bearer ${vm.environmentCredential}`);
            assert.equal(request.method, "POST");
            return HttpClientResponse.fromWeb(request, yield* response);
          }),
        ),
      ),
    );
  return {
    calls,
    provide,
    setResponse: (next: Effect.Effect<Response>) => {
      response = next;
    },
    make: makeThreadVmRepositoryAccess(vm, receipt).pipe(provide),
  };
};

describe("private VM client access", () => {
  it.effect("keeps a move guest confined to its assigned project before and after cutover", () =>
    Effect.gen(function* () {
      const f = fixture(),
        moved = { ...vm, scope: { ...vm.scope, generation: 2 } };
      f.setResponse(Effect.succeed(Response.json({ ...grant, generation: 2 })));
      const access = yield* makeThreadVmRepositoryAccess(moved, null).pipe(f.provide);
      yield* access.requireProject(owner, receipt.projectId);
      assert.equal(access.threadId, vm.scope.threadId);
      yield* Effect.flip(access.requireProject(owner, ProjectId.make("another")));
      yield* Effect.flip(access.requireThread(owner, ThreadId.make("another")));
      assert.deepEqual([...(yield* access.projectIds(owner))!], [receipt.projectId]);
      yield* Effect.flip(makeThreadVmRepositoryAccess(vm, null).pipe(f.provide));
    }),
  );

  it.effect("keeps checking new connections while an older connection is still draining", () =>
    Effect.gen(function* () {
      const f = fixture();
      const access = yield* f.make;
      yield* access.requireMember(owner);
      const draining = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* access.registerConnection(
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      f.setResponse(Effect.sync(() => new Response("revoked", { status: 403 })));
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(draining);
      f.setResponse(Effect.sync(() => Response.json(grant)));
      yield* access.requireMember(owner);
      const closed = yield* Deferred.make<void>();
      yield* access.registerConnection(Deferred.succeed(closed, undefined).pipe(Effect.asVoid));
      f.setResponse(Effect.sync(() => new Response("revoked again", { status: 403 })));
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(closed);
      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.effect(
    "authorizes exactly one thread, coalesces reads and rejects anonymous/admin escape paths",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const access = yield* f.make;
        assert.equal((yield* access.status).ready, false);
        yield* access.requireMember({}).pipe(Effect.flip);
        yield* access.requireThread(owner, ThreadId.make("sibling")).pipe(Effect.flip);
        yield* access.requireProject(owner, ProjectId.make("sibling")).pipe(Effect.flip);
        assert.equal(f.calls.length, 0);
        yield* Effect.all(
          Array.from({ length: 8 }, () => access.requireThread(owner, vm.scope.threadId)),
          { concurrency: "unbounded" },
        );
        assert.deepEqual(f.calls, [
          "https://relay.test/v1/environments/environment/threads/thread/access/check",
        ]);
        assert.equal((yield* access.status).ready, true);
        assert.deepEqual([...(yield* access.projectIds(owner))!], [receipt.projectId]);
        yield* access.requirePersistedProject(owner, receipt.projectId);
        yield* access
          .requireMember({ user: { ...owner.user, userId: "other-admin" } })
          .pipe(Effect.flip);
        yield* access
          .authorizeClone(owner, {
            projectId: receipt.projectId,
            cloneUrl: "https://github.com/acme/other",
          })
          .pipe(Effect.flip);
        yield* access
          .requireCommand(owner, {
            type: "thread.delete",
            commandId: CommandId.make("delete"),
            threadId: vm.scope.threadId,
          })
          .pipe(Effect.flip);
        yield* access
          .apply({ organizationId: "org", revision: 100, members: [], repositories: [] }, true)
          .pipe(Effect.flip);
        assert.equal(f.calls.length, 1);
        assert.equal((yield* access.status).ready, true);
      }),
  );

  it.effect("fails closed on a missing or mismatched local enrollment receipt", () =>
    Effect.gen(function* () {
      const f = fixture();
      for (const bad of [
        null,
        { ...receipt, environmentId: EnvironmentId.make("foreign") },
        { ...receipt, operationId: "old" },
        { ...receipt, scope: { ...receipt.scope, generation: 2 } },
      ]) {
        yield* makeThreadVmRepositoryAccess(vm, bad).pipe(f.provide, Effect.flip);
      }
      assert.equal(f.calls.length, 0);
    }),
  );

  it.effect(
    "rejects relay responses for a different scope and never grants access on failure",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const access = yield* f.make;
        for (const change of [
          { environmentId: "other" },
          { threadId: "other" },
          { projectId: "other" },
          { repositoryId: "other" },
          { generation: 2 },
          { userId: "other" },
        ]) {
          f.setResponse(Effect.sync(() => Response.json({ ...grant, ...change })));
          yield* access.requireMember(owner).pipe(Effect.flip);
          assert.equal((yield* access.status).ready, false);
        }
        f.setResponse(Effect.sync(() => new Response("unavailable", { status: 503 })));
        yield* access.requireMember(owner).pipe(Effect.flip);
        f.setResponse(Effect.sync(() => Response.json(grant)));
        yield* access.requireMember(owner);
      }),
  );

  it.effect("revokes idle connections and releases the fence before awaiting their drains", () =>
    Effect.gen(function* () {
      const f = fixture();
      const access = yield* f.make;
      yield* access.requireMember(owner);
      const closed = yield* Deferred.make<void>();
      yield* access.registerConnection(
        access.withFence(Deferred.succeed(closed, undefined)).pipe(Effect.asVoid),
      );
      f.setResponse(Effect.sync(() => new Response("denied", { status: 403 })));
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(closed);
      assert.equal((yield* access.status).ready, false);
      yield* access.requireMember(owner).pipe(Effect.flip);
      f.setResponse(Effect.sync(() => Response.json(grant)));
      yield* access.requireMember(owner);
      const calls = f.calls.length;
      yield* TestClock.adjust("10 seconds");
      assert.equal(f.calls.length, calls); // Closed connections are no longer renewed.
      assert.equal((yield* access.status).ready, false);
    }),
  );

  it.effect("bounds relay outage retries and drains the connection when renewal times out", () =>
    Effect.gen(function* () {
      const f = fixture();
      const access = yield* f.make;
      yield* access.requireMember(owner);
      const closed = yield* Deferred.make<void>();
      yield* access.registerConnection(Deferred.succeed(closed, undefined).pipe(Effect.asVoid));
      const requested = yield* Deferred.make<void>();
      f.setResponse(Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)));
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(requested);
      assert.equal((yield* access.status).ready, false);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(closed);
      assert.equal(f.calls.length, 2);
    }),
  );

  it.effect("does not poll the relay after the last connection unregisters", () =>
    Effect.gen(function* () {
      const f = fixture();
      const access = yield* f.make;
      yield* access.requireMember(owner);
      const unregister = yield* access.registerConnection(Effect.die("already disconnected"));
      unregister();
      yield* TestClock.adjust("15 seconds");
      assert.equal(f.calls.length, 1);
    }),
  );
});
