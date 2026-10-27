import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const ThreadTransferNativeCursor = Schema.Struct({
  threadId: Schema.NonEmptyString,
  resumePolicy: Schema.Literal("require-existing"),
  portableStateId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export const ThreadTransferNativeRuntime = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  ...ThreadTransferNativeCursor.fields,
});
const decodeNative = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.NullOr(ThreadTransferNativeRuntime)),
);
const decodeStoppedPayload = Schema.decodeUnknownEffect(
  Schema.NullOr(
    Schema.fromJsonString(
      Schema.NullOr(
        Schema.Struct({
          activeTurnId: Schema.Null,
          lastRuntimeEvent: Schema.Literal("provider.stopAll"),
          lastRuntimeEventAt: Schema.DateTimeUtcFromString,
        }),
      ),
    ),
  ),
  { onExcessProperty: "error" },
);
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadTransferNativeCursor));
export class ThreadTransferRuntimeError extends Schema.TaggedError<ThreadTransferRuntimeError>()(
  "ThreadTransferRuntimeError",
  {},
) {
  override get message() {
    return "The installed native runtime no longer matches the transferred conversation.";
  }
}

/** Check inside the ownership transaction too: a ready receipt must not activate
 * a different native cursor than the one the setup worker actually verified.
 */
export const assertThreadTransferRuntime = Effect.fn("assertThreadTransferRuntime")(
  function* (sql: SqlClient.SqlClient, operationId: string) {
    const [baseline] = yield* sql<{ threadId: string; native: string | null; mode: string }>`
      SELECT b.thread_id AS "threadId", b.native_runtime_json AS native, t.runtime_mode AS mode
      FROM thread_transfer_baselines b JOIN projection_threads t USING(thread_id)
      WHERE b.operation_id = ${operationId}`;
    if (!baseline || baseline.native === null) return yield* new ThreadTransferRuntimeError();
    const native = yield* decodeNative(baseline.native);
    const [runtime] = yield* sql<{
      provider: string;
      instanceId: string;
      adapter: string;
      status: string;
      mode: string;
      cursor: string | null;
      payload: string | null;
    }>`
      SELECT provider_name AS provider, provider_instance_id AS "instanceId", adapter_key AS adapter,
        status, runtime_mode AS mode, resume_cursor_json AS cursor, runtime_payload_json AS payload
      FROM provider_session_runtime WHERE thread_id = ${baseline.threadId}`;
    if (!native) {
      if (runtime) return yield* new ThreadTransferRuntimeError();
      return;
    }
    if (
      !runtime ||
      runtime.provider !== "codex" ||
      runtime.adapter !== "codex" ||
      runtime.instanceId !== native.providerInstanceId ||
      runtime.status !== "stopped" ||
      runtime.mode !== baseline.mode ||
      runtime.cursor === null
    )
      return yield* new ThreadTransferRuntimeError();
    // Imported runtimes start empty; graceful shutdown adds only idle stopAll telemetry.
    yield* decodeStoppedPayload(runtime.payload);
    const cursor = yield* decodeCursor(runtime.cursor);
    if (cursor.threadId !== native.threadId || cursor.portableStateId !== native.portableStateId)
      return yield* new ThreadTransferRuntimeError();
  },
  Effect.mapError(() => new ThreadTransferRuntimeError()),
);
