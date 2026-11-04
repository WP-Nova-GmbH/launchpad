import { managedTunnelsDisabled } from "../cloud/config.ts";
import type {
  RelayManagedEndpointRuntimeConfig,
  RelayThreadVmManagedEndpoint,
} from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";

export class ThreadVmManagedEndpointError extends Schema.TaggedError<ThreadVmManagedEndpointError>()(
  "ThreadVmManagedEndpointError",
  {},
) {
  override get message() {
    return "The private VM tunnel is waiting for relay authorization.";
  }
}

/** Owns one connector for this server lifetime. Recovery uses the narrow VM identity, never a personal link. */
export const runThreadVmManagedEndpointWith = <E, R>(input: {
  readonly recover: Effect.Effect<typeof RelayThreadVmManagedEndpoint.Type, E, R>;
  readonly release: (tunnelId: string) => Effect.Effect<unknown, E, R>;
}) =>
  Effect.gen(function* () {
    if (yield* managedTunnelsDisabled) return;
    const runtime = yield* CloudManagedEndpointRuntime;
    let current: RelayManagedEndpointRuntimeConfig | undefined;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* runtime.applyConfig(null);
        if (current?.tunnelId)
          yield* input.release(current.tunnelId).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      }),
    );
    const reconnect = input.recover.pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (
            response.runtime.providerKind !== "cloudflare_tunnel" ||
            !response.runtime.tunnelId ||
            response.endpoint.providerKind !== "cloudflare_tunnel"
          )
            return yield* new ThreadVmManagedEndpointError();
          current = response.runtime;
          const status = yield* runtime.applyConfig(response.runtime);
          if (status.status !== "running") return yield* new ThreadVmManagedEndpointError();
        }),
      ),
      Effect.timeout("30 seconds"),
      Effect.catch((error) => runtime.applyConfig(null).pipe(Effect.andThen(Effect.fail(error)))),
      Effect.retry({ schedule: Schedule.spaced("30 seconds") }),
    );
    yield* reconnect;
    yield* Stream.runForEach(runtime.recoveryRequests, () => reconnect);
  });

export const runThreadVmManagedEndpoint = Effect.gen(function* () {
  if (yield* managedTunnelsDisabled) return;
  const vm = yield* readInstalledThreadVm();
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  if (!vm || vm.environmentId !== environmentId) return yield* new ThreadVmManagedEndpointError();
  const url = normalizeSecureRelayUrl(vm.relayUrl),
    issuer = normalizeSecureRelayUrl(vm.relayIssuer);
  if (!url || !issuer) return yield* new ThreadVmManagedEndpointError();
  const sql = yield* SqlClient.SqlClient;
  // Opening a cancelled source's local fence precedes its relay acknowledgement.
  // Read the fence and pending acknowledgement in one snapshot before the first recovery.
  yield* sql<{ relayUrl: string }>`SELECT f.relay_url AS "relayUrl"
    FROM thread_execution_fences f WHERE f.thread_id=${vm.scope.threadId}
    AND f.environment_id=${environmentId} AND f.generation=${vm.scope.generation} AND f.phase='active'
    AND NOT EXISTS (SELECT 1 FROM thread_move_source_reopens r
      WHERE r.operation_id=f.operation_id AND r.thread_id=f.thread_id AND r.relay_url=f.relay_url
      AND r.environment_id=f.environment_id AND r.generation=f.generation)`.pipe(
    Effect.map(([fence]) => !!fence && normalizeSecureRelayUrl(fence.relayUrl) === url),
    Effect.orElseSucceed(() => false),
    Effect.repeat({ until: (ready: boolean) => ready, schedule: Schedule.spaced("500 millis") }),
  );
  const client = yield* makeExecutorRelayApiClient({
    url,
    issuer,
    environmentCredential: vm.environmentCredential,
  });
  const params = { environmentId, threadId: vm.scope.threadId };
  const payload = { generation: vm.scope.generation };
  yield* runThreadVmManagedEndpointWith({
    recover: client.threadEnvironment
      .recoverEndpoint({ params, payload })
      .pipe(Effect.mapError(() => new ThreadVmManagedEndpointError())),
    release: (tunnelId) =>
      client.threadEnvironment
        .releaseEndpoint({ params, payload: { ...payload, tunnelId } })
        .pipe(Effect.mapError(() => new ThreadVmManagedEndpointError())),
  });
});
