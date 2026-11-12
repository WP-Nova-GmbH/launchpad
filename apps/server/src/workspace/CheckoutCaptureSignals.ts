import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// Each database owns its local wake-ups; durable holds remain the source of truth.
const listeners = new WeakMap<SqlClient.SqlClient, Set<(checkoutRoot: string) => void>>();

export const checkoutCaptureReleases = (sql: SqlClient.SqlClient) =>
  Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let subscribed = listeners.get(sql);
        if (!subscribed) listeners.set(sql, (subscribed = new Set()));
        const offer = (root: string) => void Queue.offerUnsafe(queue, root);
        subscribed.add(offer);
        return () => subscribed.delete(offer);
      }),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );

export const notifyCheckoutCaptureReleased = (sql: SqlClient.SqlClient, checkoutRoot: string) =>
  Effect.sync(() => {
    for (const listener of listeners.get(sql) ?? []) listener(checkoutRoot);
  });
