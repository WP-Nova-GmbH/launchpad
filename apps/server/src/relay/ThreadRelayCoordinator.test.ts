import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadMoveSweep } from "./ThreadRelayCoordinator.ts";

const testLayer = SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer));
const discovery = {
  threadId: "",
  environmentId: EnvironmentId.make("source"),
  relayUrl: "https://relay.example",
  generation: 1,
};
const authority = {
  discoveryOwner: Effect.succeed(discovery),
  moves: { pending: () => Effect.succeed({ entries: [], next: null }) },
};
const enrollment = { synchronize: () => Effect.succeed(true) };
const unexpected = () => Effect.die("Unexpected move worker");
const frozenMove = Effect.fnUntraced(function* (threadId: string, destination = false) {
  const sql = yield* SqlClient.SqlClient;
  const fences = makeThreadExecutionFence(sql);
  const owner = {
    ...discovery,
    threadId,
    projectId: `${threadId}-project`,
    operationId: `${threadId}-move`,
    generation: destination ? 2 : 1,
  };
  yield* fences.prepare(owner);
  if (!destination)
    yield* sql`INSERT INTO projection_thread_prompt_queues (thread_id,state_json)
      VALUES (${threadId},'{"entries":[{"kind":"move"}]}')`;
  return { fences, owner };
});

it.effect("keeps a failed source frozen and reconciles cancellation on the next pass", () =>
  Effect.gen(function* () {
    const failed = yield* frozenMove("failed"),
      healthy = yield* frozenMove("healthy");
    const calls: string[] = [];
    let relayAborted = false;
    const sweep = yield* makeThreadMoveSweep(authority, enrollment, {
      source: (threadId) =>
        Effect.gen(function* () {
          calls.push(threadId);
          if (threadId !== failed.owner.threadId) return;
          if (!relayAborted) return yield* Effect.die(new TypeError("archive export defect"));
          // The real worker activates only after the relay certifies cancellation.
          yield* failed.fences.activate(failed.owner);
        }),
      destination: unexpected,
    });
    yield* sweep;
    expect(calls).toEqual(["failed", "healthy"]);
    expect((yield* failed.fences.get("failed"))?.phase).toBe("frozen");
    expect((yield* healthy.fences.get("healthy"))?.phase).toBe("frozen");
    relayAborted = true;
    yield* sweep;
    expect(calls).toEqual(["failed", "healthy", "failed", "healthy"]);
    expect((yield* failed.fences.get("failed"))?.phase).toBe("active");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("isolates a destination defect and retries that destination on the next pass", () =>
  Effect.gen(function* () {
    const failed = yield* frozenMove("failed", true);
    yield* frozenMove("healthy", true);
    const calls: string[] = [];
    let failImport = true;
    const sweep = yield* makeThreadMoveSweep(authority, enrollment, {
      source: unexpected,
      destination: (owner) =>
        Effect.gen(function* () {
          calls.push(owner.threadId);
          if (owner.threadId !== failed.owner.threadId) return;
          if (failImport) return yield* Effect.die(new TypeError("archive import defect"));
          yield* failed.fences.activate(owner);
        }),
    });
    yield* sweep;
    expect(calls).toEqual(["failed", "healthy"]);
    expect((yield* failed.fences.get("failed"))?.phase).toBe("frozen");
    failImport = false;
    yield* sweep;
    expect(calls).toEqual(["failed", "healthy", "failed", "healthy"]);
    expect((yield* failed.fences.get("failed"))?.phase).toBe("active");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("continues the recurring sweep after a discovery defect", () =>
  Effect.gen(function* () {
    yield* frozenMove("waiting");
    let discoveryCalls = 0,
      sourceCalls = 0;
    const sweep = yield* makeThreadMoveSweep(
      {
        ...authority,
        discoveryOwner: Effect.gen(function* () {
          discoveryCalls++;
          if (discoveryCalls === 1) return yield* Effect.die(new TypeError("discovery defect"));
          return discovery;
        }),
      },
      enrollment,
      {
        source: () =>
          Effect.sync(() => {
            sourceCalls++;
            return undefined;
          }),
        destination: unexpected,
      },
    );
    yield* sweep.pipe(Effect.repeat(Schedule.recurs(1)));
    expect(discoveryCalls).toBe(2);
    expect(sourceCalls).toBe(1);
  }).pipe(Effect.provide(testLayer)),
);

for (const stage of ["discovery", "source", "destination"] as const)
  it.effect(`preserves shutdown interruption during ${stage}`, () =>
    Effect.gen(function* () {
      yield* frozenMove("first", stage === "destination");
      yield* frozenMove("second", stage === "destination");
      let laterCalls = 0;
      const stop = (threadId: string) =>
        threadId === "first"
          ? Effect.interrupt
          : Effect.sync(() => {
              laterCalls++;
              return undefined;
            });
      const sweep = yield* makeThreadMoveSweep(
        stage === "discovery" ? { ...authority, discoveryOwner: Effect.interrupt } : authority,
        enrollment,
        {
          source: stage === "source" ? stop : unexpected,
          destination: stage === "destination" ? (owner) => stop(owner.threadId) : unexpected,
        },
      );
      const exit = yield* Effect.exit(sweep);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(laterCalls).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );
