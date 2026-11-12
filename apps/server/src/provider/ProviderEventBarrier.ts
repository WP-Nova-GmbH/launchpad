import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ProviderValidationError } from "./Errors.ts";

/** An in-process stream receipt, never a provider or client wire event. */
export class ProviderEventBarrier {
  readonly threadId: ThreadId;
  readonly done: Deferred.Deferred<void, ProviderValidationError>;
  constructor(threadId: ThreadId, done: Deferred.Deferred<void, ProviderValidationError>) {
    this.threadId = threadId;
    this.done = done;
  }
}
export type ProviderIngestionEvent = ProviderRuntimeEvent | ProviderEventBarrier;
/** Emit single events in order. A barrier runs only after downstream consumed
 * earlier events; mapping a whole chunk before forwarding it would acknowledge early.
 */
export const consumeProviderEventBarriers = (stream: Stream.Stream<ProviderIngestionEvent>) =>
  stream.pipe(
    Stream.flatMap((event) =>
      event instanceof ProviderEventBarrier
        ? Stream.fromEffect(Deferred.succeed(event.done, undefined)).pipe(Stream.drain)
        : Stream.succeed(event),
    ),
  );
