import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CheckoutCaptureError } from "../persistence/CheckoutCapture.ts";
import { ThreadExecutionFenceError } from "../persistence/ThreadExecutionFence.ts";
import { makeProviderExecution } from "./ProviderExecution.ts";

it.effect("a capture hold is retryable only when no native invocation was started", () =>
  Effect.gen(function* () {
    const admit = makeProviderExecution({
      begin: () =>
        Effect.fail(
          new CheckoutCaptureError({ message: "Waiting for snapshot", waitingForCheckout: true }),
        ),
      wasStarted: () => Effect.succeed(false),
      completeInvocation: () => Effect.die("A rejected invocation must not complete"),
      rejectInvocation: () => Effect.die("A missing invocation must not reject"),
      bindTurn: () => Effect.die("A rejected invocation must not bind a turn"),
    });
    const error = yield* Effect.flip(admit("thread", "send-turn", "attempt"));
    assert.isTrue(error.waitingForCheckout);
    assert.isFalse(error.uncertain);
  }),
);

it.effect("an unreadable admission receipt preserves uncertainty", () =>
  Effect.gen(function* () {
    const admit = makeProviderExecution({
      begin: () =>
        Effect.fail(
          new CheckoutCaptureError({ message: "Waiting for snapshot", waitingForCheckout: true }),
        ),
      wasStarted: () =>
        Effect.fail(
          new ThreadExecutionFenceError({ threadId: "thread", detail: "Receipt unavailable" }),
        ),
      completeInvocation: () => Effect.die("An uncertain invocation must not complete"),
      rejectInvocation: () => Effect.die("An uncertain invocation must not reject"),
      bindTurn: () => Effect.die("An uncertain invocation must not bind a turn"),
    });
    const error = yield* Effect.flip(admit("thread", "send-turn", "attempt"));
    assert.isTrue(error.uncertain);
  }),
);
