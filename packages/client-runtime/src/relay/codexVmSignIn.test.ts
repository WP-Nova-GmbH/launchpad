import { describe, expect, it } from "@effect/vitest";
import { CodexVmSignInError, type CodexVmSignInCallback } from "@t3tools/contracts";
import {
  CodexVmConnectionError,
  RelayOrganizationId,
  type RelayCodexVmConnection,
  type RelayCodexVmSignInAttempt,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  CodexVmSignInClientError,
  requireCodexVmOrganization,
  makeCodexVmSignInController,
  type CodexVmSignInDependencies,
} from "./codexVmSignIn.ts";
const encodeState = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const disconnected: RelayCodexVmConnection = {
  connectionId: null,
  label: null,
  status: "disconnected",
  epoch: 0,
  tokenRevision: 0,
  errorCode: null,
  refreshing: false,
};
const connected: RelayCodexVmConnection = {
  ...disconnected,
  connectionId: "organization-account",
  label: "VM account",
  status: "connected",
  epoch: 1,
  tokenRevision: 1,
};
const fixture = Effect.gen(function* () {
  const waiting = yield* Deferred.make<string>();
  const callbacks = new Map<string, Deferred.Deferred<CodexVmSignInCallback, CodexVmSignInError>>();
  const starts: Parameters<CodexVmSignInDependencies["startAttempt"]>[0][] = [];
  const completions: Parameters<CodexVmSignInDependencies["completeAttempt"]>[0][] = [];
  const opened: string[] = [],
    cancelledAttempts: string[] = [],
    cancelledBridges: string[] = [];
  let connection = disconnected,
    bridgeCount = 0;
  let recovered: RelayCodexVmSignInAttempt | null = null;
  const deps: CodexVmSignInDependencies = {
    capability: Effect.succeed(true),
    startBridge: Effect.gen(function* () {
      const id = `bridge-${++bridgeCount}`;
      callbacks.set(id, yield* Deferred.make<CodexVmSignInCallback, CodexVmSignInError>());
      return {
        bridgeId: id,
        state: id.repeat(10),
        redirectUri: "http://127.0.0.1:45001/auth/callback",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    }),
    waitBridge: (id) =>
      Deferred.succeed(waiting, id).pipe(
        Effect.andThen(Effect.suspend(() => Deferred.await(callbacks.get(id)!))),
      ),
    cancelBridge: (id) =>
      Effect.gen(function* () {
        cancelledBridges.push(id);
        const callback = callbacks.get(id);
        if (callback)
          yield* Deferred.fail(callback, new CodexVmSignInError({ reason: "cancelled" }));
      }),
    readConnection: Effect.sync(() => connection),
    startAttempt: (payload) =>
      Effect.sync(() => {
        starts.push(payload);
        return {
          attempt: {
            attemptId: `attempt-${starts.length}`,
            expiresAt: "2099-01-01T00:00:00.000Z",
            phase: "pending",
          },
          authorizationUrl:
            "https://auth.openai.com/oauth/authorize?client_id=dynamic_agent_client",
        };
      }),
    completeAttempt: (payload) =>
      Effect.sync(() => {
        completions.push(payload);
        connection = connected;
        return connection;
      }),
    readAttempt: () => Effect.sync(() => recovered),
    cancelAttempt: (id) =>
      Effect.sync(() => {
        cancelledAttempts.push(id);
        return connection;
      }),
    disconnect: Effect.sync(() => {
      connection = { ...connected, status: "disconnected", epoch: 2 };
      return connection;
    }),
    openAuthorization: (url) =>
      Effect.sync(() => {
        opened.push(url);
      }),
  };
  return {
    deps,
    waiting,
    starts,
    completions,
    opened,
    cancelledAttempts,
    cancelledBridges,
    setConnection: (value: RelayCodexVmConnection) => {
      connection = value;
    },
    recover: (value: RelayCodexVmSignInAttempt | null) => {
      recovered = value;
    },
    callback: (id: string, payload?: Partial<CodexVmSignInCallback>) =>
      Deferred.succeed(callbacks.get(id)!, {
        state: id.repeat(10),
        code: "one-use-code-canary",
        clientId: "issued-client-id",
        ...payload,
      }),
  };
});

describe("organization Codex sign-in controller", () => {
  it.effect(
    "retains an account through a failed lookup and clears the read error only after retry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture,
          entered = yield* Deferred.make<void>(),
          reply = yield* Deferred.make<RelayCodexVmConnection>();
        let mode: "ready" | "failed" | "retrying" = "ready";
        f.setConnection(connected);
        const controller = makeCodexVmSignInController({
          ...f.deps,
          readConnection: Effect.suspend(() =>
            mode === "failed"
              ? Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" }))
              : mode === "retrying"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(reply)))
                : f.deps.readConnection,
          ),
        });
        yield* controller.refresh;
        mode = "failed";
        yield* controller.refresh;
        expect(controller.getSnapshot()).toMatchObject({
          connection: connected,
          connectionReadError: expect.stringContaining("Could not reach"),
          error: null,
          loading: false,
        });
        mode = "retrying";
        const retry = yield* controller.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(controller.getSnapshot()).toMatchObject({
          loading: true,
          connectionReadError: expect.stringContaining("Could not reach"),
        });
        yield* Deferred.succeed(reply, connected);
        yield* Fiber.join(retry);
        expect(controller.getSnapshot()).toMatchObject({
          connection: connected,
          connectionReadError: null,
          error: null,
          loading: false,
        });
        expect(f.starts).toEqual([]);
        expect(f.completions).toEqual([]);
      }),
  );

  it.effect("keeps an initial failed lookup unknown until a disconnected snapshot is read", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let failRead = true;
      const controller = makeCodexVmSignInController({
        ...f.deps,
        readConnection: Effect.suspend(() =>
          failRead
            ? Effect.fail(new CodexVmSignInClientError({ reason: "signed_out" }))
            : f.deps.readConnection,
        ),
      });
      yield* controller.refresh;
      expect(controller.getSnapshot()).toMatchObject({
        connection: null,
        connectionReadError: "Sign in to Launchpad Connect first.",
        error: null,
      });
      failRead = false;
      yield* controller.refresh;
      expect(controller.getSnapshot()).toMatchObject({
        connection: disconnected,
        connectionReadError: null,
        error: null,
      });
    }),
  );

  it.effect(
    "keeps a lookup error through sign-in setup and clears it on the authoritative reply",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let failRead = false;
        f.setConnection(connected);
        const controller = makeCodexVmSignInController({
          ...f.deps,
          readConnection: Effect.suspend(() =>
            failRead
              ? Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" }))
              : f.deps.readConnection,
          ),
        });
        yield* controller.refresh;
        failRead = true;
        yield* controller.refresh;
        const work = yield* controller.reconnect.pipe(Effect.forkChild);
        const bridgeId = yield* Deferred.await(f.waiting);
        expect(controller.getSnapshot()).toMatchObject({
          busy: true,
          connectionReadError: expect.stringContaining("Could not reach"),
        });
        yield* f.callback(bridgeId);
        yield* Fiber.join(work);
        expect(controller.getSnapshot()).toMatchObject({
          connection: connected,
          busy: false,
          connectionReadError: null,
          error: null,
        });
        expect(f.starts[0]?.intent).toBe("reconnect");
      }),
  );

  it.effect("does not let an older account snapshot clear a newer lookup error", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let failRead = false;
      f.setConnection(connected);
      const controller = makeCodexVmSignInController({
        ...f.deps,
        readConnection: Effect.suspend(() =>
          failRead
            ? Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" }))
            : f.deps.readConnection,
        ),
      });
      yield* controller.refresh;
      failRead = true;
      yield* controller.refresh;
      failRead = false;
      f.setConnection(disconnected);
      yield* controller.refresh;
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        connectionReadError: expect.stringContaining("Could not reach"),
      });
      f.setConnection(connected);
      yield* controller.refresh;
      expect(controller.getSnapshot().connectionReadError).toBeNull();
    }),
  );

  it.effect(
    "keeps failed attempt recovery separate from metadata and recovers without another exchange",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let completions = 0,
          failRecovery = false;
        const controller = makeCodexVmSignInController({
          ...f.deps,
          completeAttempt: () =>
            Effect.sync(() => {
              completions++;
              f.setConnection(connected);
            }).pipe(
              Effect.andThen(Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" }))),
            ),
          readAttempt: (id) =>
            failRecovery
              ? Effect.fail(new CodexVmSignInError({ reason: "expired" }))
              : f.deps.readAttempt(id),
        });
        yield* controller.refresh;
        const work = yield* controller.connect.pipe(Effect.forkChild);
        yield* f.callback(yield* Deferred.await(f.waiting));
        yield* Fiber.join(work);
        expect(controller.getSnapshot()).toMatchObject({
          busy: false,
          attempt: { phase: "exchanging" },
          connectionReadError: null,
          error: expect.stringContaining("Could not reach"),
        });
        failRecovery = true;
        yield* controller.refresh;
        expect(controller.getSnapshot()).toMatchObject({
          connection: connected,
          connectionReadError: null,
          error: "Codex sign-in expired. Start again.",
        });
        failRecovery = false;
        f.recover({
          attemptId: "attempt-1",
          expiresAt: "2099-01-01T00:00:00Z",
          phase: "completed",
        });
        yield* controller.refresh;
        expect(controller.getSnapshot()).toMatchObject({
          connection: connected,
          connectionReadError: null,
          error: null,
          attempt: { phase: "completed" },
        });
        expect(completions).toBe(1);
        expect(f.starts).toHaveLength(1);
      }),
  );

  it.effect(
    "retains cancellation uncertainty after a failed readback and repairs it through metadata",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let failRead = false;
        f.setConnection({ ...connected, revocationUnconfirmed: true });
        const controller = makeCodexVmSignInController({
          ...f.deps,
          readConnection: Effect.suspend(() =>
            failRead
              ? Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" }))
              : f.deps.readConnection,
          ),
        });
        yield* controller.refresh;
        const work = yield* controller.reconnect.pipe(Effect.forkChild);
        yield* Deferred.await(f.waiting);
        failRead = true;
        yield* controller.cancel;
        yield* Fiber.join(work);
        expect(controller.getSnapshot()).toMatchObject({
          connectionReadError: expect.stringContaining("Could not reach"),
          error: expect.stringContaining("Could not confirm cancellation"),
          warning: expect.stringContaining("revocation could not be confirmed"),
        });
        failRead = false;
        yield* controller.refresh;
        expect(controller.getSnapshot()).toMatchObject({
          connection: { status: "connected" },
          connectionReadError: null,
          error: null,
          warning: expect.stringContaining("revocation could not be confirmed"),
        });
      }),
  );

  it.effect("distinguishes a disconnect failure from an unavailable readback", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let failRead = false;
      f.setConnection(connected);
      const controller = makeCodexVmSignInController({
        ...f.deps,
        disconnect: Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" })),
        readConnection: Effect.suspend(() =>
          failRead
            ? Effect.fail(new CodexVmSignInClientError({ reason: "signed_out" }))
            : f.deps.readConnection,
        ),
      });
      yield* controller.refresh;
      yield* controller.disconnect;
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        connectionReadError: null,
        error: expect.stringContaining("Could not reach"),
      });
      failRead = true;
      yield* controller.disconnect;
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        connectionReadError: "Sign in to Launchpad Connect first.",
        error: expect.stringContaining("Could not reach"),
      });
    }),
  );

  it.effect("ignores a stale failed lookup after a newer sign-in succeeds", () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        entered = yield* Deferred.make<void>(),
        reply = yield* Deferred.make<RelayCodexVmConnection, CodexVmSignInClientError>();
      const controller = makeCodexVmSignInController({
        ...f.deps,
        readConnection: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(reply)),
        ),
      });
      const lookup = yield* controller.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const work = yield* controller.connect.pipe(Effect.forkChild);
      yield* f.callback(yield* Deferred.await(f.waiting));
      yield* Fiber.join(work);
      yield* Deferred.fail(reply, new CodexVmSignInClientError({ reason: "unavailable" }));
      yield* Fiber.join(lookup);
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        connectionReadError: null,
        error: null,
      });
    }),
  );

  it.effect(
    "fences a completion-recovery read when a later refresh already recovered the same flow",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture,
          entered = yield* Deferred.make<void>(),
          reply = yield* Deferred.make<RelayCodexVmConnection, CodexVmSignInClientError>();
        let completions = 0,
          reads = 0,
          holdRecovery = false;
        const controller = makeCodexVmSignInController({
          ...f.deps,
          completeAttempt: () =>
            Effect.sync(() => {
              completions++;
              f.setConnection(connected);
            }).pipe(
              Effect.andThen(Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" }))),
            ),
          readConnection: Effect.suspend(() =>
            holdRecovery && ++reads === 2
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(reply)))
              : f.deps.readConnection,
          ),
        });
        const work = yield* controller.connect.pipe(Effect.forkChild);
        yield* f.callback(yield* Deferred.await(f.waiting));
        yield* Fiber.join(work);
        f.recover({
          attemptId: "attempt-1",
          expiresAt: "2099-01-01T00:00:00Z",
          phase: "completed",
        });
        holdRecovery = true;
        const oldLookup = yield* controller.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* controller.refresh;
        yield* Deferred.fail(reply, new CodexVmSignInClientError({ reason: "unavailable" }));
        yield* Fiber.join(oldLookup);
        expect(controller.getSnapshot()).toMatchObject({
          connection: connected,
          connectionReadError: null,
          error: null,
          attempt: { phase: "completed" },
        });
        expect(completions).toBe(1);
        expect(f.starts).toHaveLength(1);
      }),
  );

  it.effect("keeps metadata available when a downlevel server lacks the callback capability", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setConnection(connected);
      const controller = makeCodexVmSignInController({
        ...f.deps,
        capability: Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" })),
      });
      yield* controller.refresh;
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        supported: false,
        loading: false,
        error: null,
      });
      yield* controller.disconnect;
      expect(controller.getSnapshot().connection?.status).toBe("disconnected");
    }),
  );

  it.effect("reads back a completed grant when cancellation overtakes its delayed reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        committed = yield* Deferred.make<void>(),
        reply = yield* Deferred.make<RelayCodexVmConnection>();
      const controller = makeCodexVmSignInController({
        ...f.deps,
        completeAttempt: () =>
          Effect.sync(() => f.setConnection(connected)).pipe(
            Effect.andThen(Deferred.succeed(committed, undefined)),
            Effect.andThen(Deferred.await(reply)),
          ),
      });
      yield* controller.refresh;
      const work = yield* controller.connect.pipe(Effect.forkChild);
      yield* f.callback(yield* Deferred.await(f.waiting));
      yield* Deferred.await(committed);
      expect(controller.getSnapshot().authorizationUrl).toBeNull();
      expect(controller.getSnapshot().attempt?.phase).toBe("exchanging");
      yield* controller.cancel;
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        attempt: null,
        busy: false,
      });
      yield* Deferred.succeed(reply, { ...connected, label: "stale-response" });
      yield* Fiber.join(work);
      expect(controller.getSnapshot().connection?.label).toBe("VM account");
    }),
  );

  it.effect("rechecks expected user and organization after asynchronous membership lookup", () =>
    Effect.gen(function* () {
      const membership = yield* Deferred.make<{
        organization: {
          organizationId: ReturnType<typeof RelayOrganizationId.make>;
          name: string;
          createdAt: string;
        };
        userId: string;
        role: "admin";
        joinedAt: string;
      }>();
      let current = true,
        dispatched = 0;
      const work = yield* requireCodexVmOrganization(Deferred.await(membership), {
        userId: "user",
        organizationId: "expected-org",
        current: () => current,
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            dispatched++;
          }),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      current = false;
      yield* Deferred.succeed(membership, {
        userId: "user",
        organization: {
          organizationId: RelayOrganizationId.make("expected-org"),
          name: "Expected",
          createdAt: "now",
        },
        role: "admin" as const,
        joinedAt: "now",
      });
      expect((yield* Fiber.join(work)).reason).toBe("signed_out");
      expect(dispatched).toBe(0);
      const wrongOrg = requireCodexVmOrganization(
        Effect.succeed({
          userId: "user",
          organization: {
            organizationId: RelayOrganizationId.make("other-org"),
            name: "Other",
            createdAt: "now",
          },
          role: "admin" as const,
          joinedAt: "now",
        }),
        { userId: "user", organizationId: "expected-org", current: () => true },
      );
      expect((yield* wrongOrg.pipe(Effect.flip)).reason).toBe("signed_out");
    }),
  );
  it.effect("connects once through a bound local callback and confirms first plan use", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let recoveryReads = 0;
      f.recover({ attemptId: "attempt-1", expiresAt: "2099-01-01T00:00:00Z", phase: "completed" });
      const controller = makeCodexVmSignInController({
        ...f.deps,
        readAttempt: (id) =>
          Effect.sync(() => {
            recoveryReads++;
          }).pipe(Effect.andThen(f.deps.readAttempt(id))),
      });
      yield* controller.refresh;
      const work = yield* controller.connect.pipe(Effect.forkChild);
      const bridgeId = yield* Deferred.await(f.waiting);
      expect(controller.getSnapshot()).toMatchObject({
        busy: true,
        connection: disconnected,
        attempt: { phase: "pending" },
        authorizationUrl: "https://auth.openai.com/oauth/authorize?client_id=dynamic_agent_client",
      });
      expect(f.starts[0]).toMatchObject({
        intent: "connect",
        state: bridgeId.repeat(10),
        redirectUri: "http://127.0.0.1:45001/auth/callback",
      });
      expect(f.opened).toHaveLength(1);
      yield* f.callback(bridgeId);
      yield* Fiber.join(work);
      expect(f.completions).toEqual([
        {
          attemptId: "attempt-1",
          state: bridgeId.repeat(10),
          code: "one-use-code-canary",
          clientId: "issued-client-id",
        },
      ]);
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        busy: false,
        error: null,
        needsPlanConfirmation: true,
        authorizationUrl: null,
      });
      expect(yield* encodeState(controller.getSnapshot())).not.toContain("one-use-code-canary");
      controller.dismissPlanConfirmation();
      expect(controller.getSnapshot().needsPlanConfirmation).toBe(false);
      yield* controller.refresh;
      yield* controller.refresh;
      yield* controller.refresh;
      expect(controller.getSnapshot().needsPlanConfirmation).toBe(false);
      expect(recoveryReads).toBe(0);
      expect(f.completions).toHaveLength(1);
    }),
  );

  it.effect("checks local capability before creating any callback or relay grant", () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        controller = makeCodexVmSignInController({ ...f.deps, capability: Effect.succeed(false) });
      yield* controller.connect;
      expect(f.starts).toEqual([]);
      expect(f.opened).toEqual([]);
      expect(controller.getSnapshot()).toMatchObject({
        supported: false,
        busy: false,
        error: expect.stringContaining("computer running Launchpad"),
      });
    }),
  );

  it.effect("never exposes an unapproved authorization URL as a browser recovery link", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const controller = makeCodexVmSignInController({
        ...f.deps,
        startAttempt: (payload) =>
          f.deps.startAttempt(payload).pipe(
            Effect.map((response) => ({
              ...response,
              authorizationUrl: "https://another-origin.invalid/authorize",
            })),
          ),
      });
      yield* controller.connect;
      expect(controller.getSnapshot()).toMatchObject({ authorizationUrl: null, busy: false });
      expect(f.opened).toEqual([]);
    }),
  );

  it.effect("keeps a newer recovery link when an older start response arrives late", () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      let starts = 0;
      const controller = makeCodexVmSignInController({
        ...f.deps,
        startAttempt: (payload) =>
          Effect.gen(function* () {
            const first = ++starts === 1;
            const response = yield* f.deps.startAttempt(payload);
            if (first) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return {
              ...response,
              authorizationUrl: `https://auth.openai.com/oauth/authorize?flow=${first ? "old" : "current"}`,
            };
          }),
      });
      const old = yield* controller.connect.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const latest = yield* controller.replace.pipe(Effect.forkChild);
      yield* Deferred.await(f.waiting);
      expect(controller.getSnapshot().authorizationUrl).toContain("flow=current");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(old);
      expect(controller.getSnapshot().authorizationUrl).toContain("flow=current");
      yield* controller.cancel;
      yield* Fiber.join(latest);
      expect(controller.getSnapshot().authorizationUrl).toBeNull();
    }),
  );

  it.effect(
    "preserves an existing account and never confirms plan use again during reconnect",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setConnection(connected);
        const controller = makeCodexVmSignInController(f.deps);
        yield* controller.refresh;
        const work = yield* controller.reconnect.pipe(Effect.forkChild);
        const id = yield* Deferred.await(f.waiting);
        expect(controller.getSnapshot().connection).toEqual(connected);
        yield* f.callback(id);
        yield* Fiber.join(work);
        expect(f.starts[0]?.intent).toBe("reconnect");
        expect(controller.getSnapshot().needsPlanConfirmation).toBe(false);
      }),
  );

  it.effect(
    "does not let a refresh that began before sign-in restore old connection metadata",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture,
          entered = yield* Deferred.make<void>(),
          oldRead = yield* Deferred.make<RelayCodexVmConnection>();
        const controller = makeCodexVmSignInController({
          ...f.deps,
          readConnection: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(oldRead)),
          ),
        });
        const read = yield* controller.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const work = yield* controller.connect.pipe(Effect.forkChild);
        yield* f.callback(yield* Deferred.await(f.waiting));
        yield* Fiber.join(work);
        yield* Deferred.succeed(oldRead, disconnected);
        yield* Fiber.join(read);
        expect(controller.getSnapshot().connection).toEqual(connected);
      }),
  );

  it.effect("recovers a lost completion reply by status without exchanging the code twice", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let calls = 0;
      f.recover({ attemptId: "attempt-1", expiresAt: "2099-01-01T00:00:00Z", phase: "completed" });
      const controller = makeCodexVmSignInController({
        ...f.deps,
        completeAttempt: () =>
          Effect.sync(() => {
            calls++;
            f.setConnection(connected);
          }).pipe(
            Effect.andThen(Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" }))),
          ),
      });
      yield* controller.refresh;
      const work = yield* controller.connect.pipe(Effect.forkChild);
      yield* f.callback(yield* Deferred.await(f.waiting));
      yield* Fiber.join(work);
      expect(calls).toBe(1);
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        error: null,
        busy: false,
        attempt: { phase: "completed" },
      });
    }),
  );

  it.effect(
    "confirms a recovered completion once even when the notice is immediately dismissed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let completions = 0,
          recoveryReads = 0,
          confirmations = 0;
        f.recover({
          attemptId: "attempt-1",
          expiresAt: "2099-01-01T00:00:00Z",
          phase: "completed",
        });
        const controller = makeCodexVmSignInController({
          ...f.deps,
          completeAttempt: () =>
            Effect.sync(() => {
              completions++;
              f.setConnection(connected);
            }).pipe(
              Effect.andThen(Effect.fail(new CodexVmSignInClientError({ reason: "unavailable" }))),
            ),
          readAttempt: (id) =>
            Effect.sync(() => {
              recoveryReads++;
            }).pipe(Effect.andThen(f.deps.readAttempt(id))),
        });
        controller.subscribe(() => {
          if (!controller.getSnapshot().needsPlanConfirmation) return;
          confirmations++;
          controller.dismissPlanConfirmation();
        });
        const work = yield* controller.connect.pipe(Effect.forkChild);
        yield* f.callback(yield* Deferred.await(f.waiting));
        yield* Fiber.join(work);
        yield* controller.refresh;
        yield* controller.refresh;
        expect(controller.getSnapshot()).toMatchObject({
          connection: connected,
          error: null,
          busy: false,
          needsPlanConfirmation: false,
        });
        expect(confirmations).toBe(1);
        expect(completions).toBe(1);
        expect(recoveryReads).toBe(1);
      }),
  );

  it.effect(
    "uses the issued registration only for an explicit retry of a known failed attempt",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const secondOpened = yield* Deferred.make<void>();
        f.recover({ attemptId: "attempt-1", expiresAt: "2099-01-01T00:00:00Z", phase: "failed" });
        const controller = makeCodexVmSignInController({
          ...f.deps,
          openAuthorization: (url) =>
            f.deps
              .openAuthorization(url)
              .pipe(
                Effect.tap(() =>
                  f.opened.length === 2 ? Deferred.succeed(secondOpened, undefined) : Effect.void,
                ),
              ),
          completeAttempt: () =>
            Effect.fail(
              new CodexVmConnectionError({ reason: "invalid_grant", revocationUnconfirmed: true }),
            ),
        });
        const work = yield* controller.connect.pipe(Effect.forkChild);
        yield* f.callback(yield* Deferred.await(f.waiting));
        yield* Fiber.join(work);
        expect(controller.getSnapshot()).toMatchObject({
          retryable: true,
          warning: expect.stringContaining("revocation could not be confirmed"),
        });
        expect(f.starts).toHaveLength(1);
        const retry = yield* controller.retry.pipe(Effect.forkChild);
        yield* Deferred.await(secondOpened);
        expect(f.starts[1]).toMatchObject({ retryAttemptId: "attempt-1" });
        expect(f.starts[1]?.state).not.toBe(f.starts[0]?.state);
        yield* controller.cancel;
        yield* Fiber.join(retry);
      }),
  );

  it.effect("expires an abandoned browser and cancels its exact temporary resources", () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        now = yield* DateTime.now;
      const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(now.epochMilliseconds + 500));
      const controller = makeCodexVmSignInController({
        ...f.deps,
        startBridge: f.deps.startBridge.pipe(Effect.map((bridge) => ({ ...bridge, expiresAt }))),
      });
      const work = yield* controller.connect.pipe(Effect.forkChild);
      yield* Deferred.await(f.waiting);
      yield* TestClock.adjust(500);
      yield* Fiber.join(work);
      expect(controller.getSnapshot()).toMatchObject({
        busy: false,
        error: "Codex sign-in expired. Start again.",
        authorizationUrl: null,
      });
      expect(f.cancelledAttempts).toEqual(["attempt-1"]);
      expect(f.cancelledBridges).toEqual(["bridge-1"]);
    }),
  );

  it.effect("does not forward a callback with another flow's state", () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        controller = makeCodexVmSignInController(f.deps);
      const work = yield* controller.connect.pipe(Effect.forkChild);
      yield* f.callback(yield* Deferred.await(f.waiting), { state: "wrong-state" });
      yield* Fiber.join(work);
      expect(f.completions).toEqual([]);
      expect(controller.getSnapshot().busy).toBe(false);
      expect(controller.getSnapshot().error).toContain("invalid");
    }),
  );

  it.effect("cancels pending resources on disposal and ignores late completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        entered = yield* Deferred.make<void>(),
        reply = yield* Deferred.make<RelayCodexVmConnection>();
      const controller = makeCodexVmSignInController({
        ...f.deps,
        completeAttempt: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      });
      const work = yield* controller.connect.pipe(Effect.forkChild);
      yield* f.callback(yield* Deferred.await(f.waiting));
      yield* Deferred.await(entered);
      yield* controller.dispose;
      yield* Deferred.succeed(reply, connected);
      yield* Fiber.join(work);
      expect(controller.getSnapshot().connection).toBeNull();
      expect(controller.getSnapshot().authorizationUrl).toBeNull();
      expect(f.cancelledAttempts).toContain("attempt-1");
      expect(f.cancelledBridges).toEqual(["bridge-1"]);
    }),
  );

  it.effect("never dispatches an old disconnect after a newer sign-in wins during cleanup", () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        second = yield* Deferred.make<void>();
      let disconnects = 0;
      const controller = makeCodexVmSignInController({
        ...f.deps,
        cancelBridge: (id) =>
          id === "bridge-1"
            ? Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(f.deps.cancelBridge(id)),
              )
            : f.deps.cancelBridge(id),
        disconnect: Effect.sync(() => {
          disconnects++;
          return disconnected;
        }),
        openAuthorization: (url) =>
          f.deps
            .openAuthorization(url)
            .pipe(
              Effect.tap(() =>
                f.opened.length === 2 ? Deferred.succeed(second, undefined) : Effect.void,
              ),
            ),
      });
      const first = yield* controller.connect.pipe(Effect.forkChild);
      yield* Deferred.await(f.waiting);
      const disconnect = yield* controller.disconnect.pipe(Effect.forkChild);
      yield* Deferred.await(cleaning);
      expect(controller.getSnapshot().busy).toBe(true);
      const newer = yield* controller.replace.pipe(Effect.forkChild);
      yield* Deferred.await(second);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(disconnect);
      expect(disconnects).toBe(0);
      yield* f.callback("bridge-2");
      yield* Fiber.join(newer);
      yield* Fiber.join(first);
      expect(controller.getSnapshot()).toMatchObject({
        connection: connected,
        attempt: { attemptId: "attempt-2", phase: "completed" },
      });
    }),
  );
});
