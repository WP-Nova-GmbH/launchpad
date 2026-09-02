/**
 * ThreadPresenceService - who is looking at which thread right now, and
 * whether they are typing.
 *
 * Purely in-memory: a participant exists for as long as the WebSocket that
 * reported it, and the whole registry is empty after a restart, which matches
 * reality. Nothing here enters the event log; the projector never sees it.
 *
 * Typing is a lease rather than a flag so a client that dies mid-sentence
 * cannot leave a permanent "is typing" behind: the client renews it while
 * keys are pressed and it lapses on its own otherwise.
 *
 * @module ThreadPresenceService
 */
import type {
  AuthSessionUser,
  ThreadId,
  ThreadPresenceParticipant,
  ThreadPresenceSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";

import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

/** How long one typing report stays true without a renewal. */
export const TYPING_LEASE_MILLIS = 8_000;
/** How often lapsed typing leases are swept into a fresh snapshot. */
const TYPING_SWEEP_INTERVAL = "2 seconds";

export interface ThreadPresenceReport {
  readonly connectionId: string;
  readonly user: AuthSessionUser | null;
  readonly clientLabel: string | null;
  readonly threadId: ThreadId | null;
  readonly typing: boolean;
}

interface PresenceEntry {
  readonly connectionId: string;
  readonly user: AuthSessionUser | null;
  readonly clientLabel: string | null;
  readonly threadId: ThreadId;
  readonly typingUntilMillis: number;
  readonly updatedAt: DateTime.Utc;
}

export class ThreadPresenceService extends Context.Service<
  ThreadPresenceService,
  {
    /** Replace what one connection is doing. A null thread removes it. */
    readonly report: (input: ThreadPresenceReport) => Effect.Effect<void>;
    /** The connection went away; forget it and tell everyone. */
    readonly clear: (connectionId: string) => Effect.Effect<void>;
    /** Every participant on every thread, including the caller's own connection. */
    readonly snapshot: Effect.Effect<ThreadPresenceSnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: ThreadPresenceSnapshot;
        readonly changes: Stream.Stream<ThreadPresenceSnapshot>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/orchestration/ThreadPresence/ThreadPresenceService") {}

export function toParticipant(entry: PresenceEntry, nowMillis: number): ThreadPresenceParticipant {
  return {
    connectionId: entry.connectionId,
    threadId: entry.threadId,
    user: entry.user,
    clientLabel: entry.clientLabel,
    typing: entry.typingUntilMillis > nowMillis,
    updatedAt: DateTime.formatIso(entry.updatedAt),
  };
}

export const make = Effect.fn("orchestration.thread_presence.make")(function* () {
  const entriesRef = yield* Ref.make(new Map<string, PresenceEntry>());
  const changes = yield* PubSub.sliding<ThreadPresenceSnapshot>(1);
  const publishMutex = yield* Semaphore.make(1);

  const snapshot: Effect.Effect<ThreadPresenceSnapshot> = Effect.gen(function* () {
    const [entries, now] = yield* Effect.all([Ref.get(entriesRef), DateTime.now]);
    const nowMillis = now.epochMilliseconds;
    return {
      participants: [...entries.values()].map((entry) => toParticipant(entry, nowMillis)),
    };
  });

  const publishSnapshotUnlocked = snapshot.pipe(
    Effect.flatMap((next) => PubSub.publish(changes, next)),
    Effect.asVoid,
  );

  const report: ThreadPresenceService["Service"]["report"] = (input) =>
    publishMutex.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const changed = yield* Ref.modify(entriesRef, (entries) => {
          const previous = entries.get(input.connectionId);
          if (input.threadId === null) {
            if (previous === undefined) {
              return [false, entries] as const;
            }
            const next = new Map(entries);
            next.delete(input.connectionId);
            return [true, next] as const;
          }
          const typingUntilMillis = input.typing ? now.epochMilliseconds + TYPING_LEASE_MILLIS : 0;
          // Renewing a still-live typing lease is the common case while
          // someone types; it must not fan a snapshot out to every client.
          const unchanged =
            previous !== undefined &&
            previous.threadId === input.threadId &&
            previous.typingUntilMillis > now.epochMilliseconds === input.typing;
          const next = new Map(entries);
          next.set(input.connectionId, {
            connectionId: input.connectionId,
            user: input.user,
            clientLabel: input.clientLabel,
            threadId: input.threadId,
            typingUntilMillis,
            updatedAt: unchanged && previous ? previous.updatedAt : now,
          });
          return [!unchanged, next] as const;
        });
        if (changed) {
          yield* publishSnapshotUnlocked;
        }
      }),
    );

  const clear: ThreadPresenceService["Service"]["clear"] = (connectionId) =>
    publishMutex.withPermits(1)(
      Effect.gen(function* () {
        const removed = yield* Ref.modify(entriesRef, (entries) => {
          if (!entries.has(connectionId)) {
            return [false, entries] as const;
          }
          const next = new Map(entries);
          next.delete(connectionId);
          return [true, next] as const;
        });
        if (removed) {
          yield* publishSnapshotUnlocked;
        }
      }),
    );

  // A lapsed lease only becomes visible when someone recomputes; sweep so
  // "is typing" disappears on its own instead of waiting for the next report.
  yield* Effect.forever(
    Effect.sleep(TYPING_SWEEP_INTERVAL).pipe(
      Effect.andThen(
        publishMutex.withPermits(1)(
          Effect.gen(function* () {
            const [entries, now] = yield* Effect.all([Ref.get(entriesRef), DateTime.now]);
            const nowMillis = now.epochMilliseconds;
            const lapsed = [...entries.values()].filter(
              (entry) => entry.typingUntilMillis !== 0 && entry.typingUntilMillis <= nowMillis,
            );
            if (lapsed.length === 0) {
              return;
            }
            yield* Ref.update(entriesRef, (current) => {
              const next = new Map(current);
              for (const entry of lapsed) {
                const live = next.get(entry.connectionId);
                if (live !== undefined && live.typingUntilMillis === entry.typingUntilMillis) {
                  next.set(entry.connectionId, { ...live, typingUntilMillis: 0, updatedAt: now });
                }
              }
              return next;
            });
            yield* publishSnapshotUnlocked;
          }),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return ThreadPresenceService.of({
    report,
    clear,
    snapshot,
    subscribe: subscribeBeforeSnapshot(changes, snapshot, publishMutex),
  });
});

export const layer = Layer.effect(ThreadPresenceService, make());
