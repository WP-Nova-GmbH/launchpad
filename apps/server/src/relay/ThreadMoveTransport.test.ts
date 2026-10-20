import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ThreadId } from "@t3tools/contracts";
import type { RelayThreadArtifactReceipt } from "@t3tools/contracts/relay";
import { makeThreadMoveTransport } from "./ThreadMoveTransport.ts";

const owner = {
  threadId: "thread-1",
  environmentId: "environment-1",
  relayUrl: "https://relay.test",
  operationId: "00000000-0000-4000-8000-000000000001",
  generation: 1,
};
const file = {
  artifactId: "00000000-0000-4000-8000-000000000002",
  operationId: owner.operationId,
  kind: "workspace" as const,
  sha256: "a".repeat(64),
  sizeBytes: 64 * 1024 * 1024,
};
const receipt: RelayThreadArtifactReceipt = {
  ...file,
  threadId: ThreadId.make(owner.threadId),
  state: "complete",
};

it.effect("waits for a large move upload receipt after two minutes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const confirmed = yield* Deferred.make<RelayThreadArtifactReceipt>();
    const transport = makeThreadMoveTransport(
      () => Effect.die("An upload uses its own streaming client"),
      () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(confirmed))),
    );
    const upload = yield* transport.upload(owner, file, Stream.empty).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("3 minutes");
    yield* Deferred.succeed(confirmed, receipt);
    expect(yield* Fiber.join(upload)).toEqual(receipt);
  }),
);

it.effect("still bounds a move upload whose receipt never arrives", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const transport = makeThreadMoveTransport(
      () => Effect.die("An upload uses its own streaming client"),
      () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const upload = yield* transport
      .upload(owner, file, Stream.empty)
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(upload)).toMatchObject({
      _tag: "ThreadMoveError",
      threadId: owner.threadId,
    });
  }),
);
