import { expect, it } from "@effect/vitest";
import { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProviderEventBarrier, consumeProviderEventBarriers } from "./ProviderEventBarrier.ts";
import type { ProviderValidationError } from "./Errors.ts";

it.effect(
  "does not acknowledge a chunk's stop barrier until earlier output finishes processing",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        done = yield* Deferred.make<void, ProviderValidationError>();
      const event = yield* Schema.decodeUnknownEffect(ProviderRuntimeEvent)({
        eventId: "final-output",
        provider: "codex",
        threadId: "thread",
        createdAt: "2026-10-07T00:00:00Z",
        type: "session.exited",
        payload: {},
      });
      let persisted = 0;
      const worker = yield* consumeProviderEventBarriers(
        Stream.make(event, new ProviderEventBarrier(ThreadId.make("thread"), done)),
      ).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            persisted++;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      expect(Option.isNone(yield* Deferred.poll(done))).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(done);
      expect(persisted).toBe(1);
      yield* Fiber.join(worker);
    }),
);
