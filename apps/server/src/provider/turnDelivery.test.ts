import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { validateTurnDelivery } from "./turnDelivery.ts";

const provider = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("shared-thread");
const turnId = TurnId.make("active-turn");

it.effect("steer requires the exact active turn and never falls back to a new turn", () =>
  Effect.gen(function* () {
    const input = {
      threadId,
      input: "Use the other approach",
      delivery: { attemptId: "attempt", mode: "steer" as const, expectedTurnId: turnId },
    };
    yield* validateTurnDelivery(provider, input, turnId);
    for (const active of [undefined, TurnId.make("a-newer-turn")]) {
      const error = yield* Effect.flip(validateTurnDelivery(provider, input, active));
      assert.equal(error._tag, "ProviderAdapterValidationError");
      assert.include(error.issue, "remains queued");
    }
    const missing = yield* Effect.flip(
      validateTurnDelivery(
        provider,
        {
          ...input,
          delivery: { attemptId: "missing-target", mode: "steer" },
        },
        turnId,
      ),
    );
    assert.equal(missing._tag, "ProviderAdapterValidationError");
  }),
);

it.effect("next-turn delivery rejects a busy provider without changing legacy controls", () =>
  Effect.gen(function* () {
    const input = { threadId, input: "Next instruction" };
    yield* validateTurnDelivery(provider, input, turnId);
    yield* validateTurnDelivery(provider, input, undefined);
    const queued = { ...input, delivery: { attemptId: "next", mode: "next-turn" as const } };
    yield* validateTurnDelivery(provider, queued, undefined);
    const error = yield* Effect.flip(validateTurnDelivery(provider, queued, turnId));
    assert.include(error.issue, "already running");
  }),
);
