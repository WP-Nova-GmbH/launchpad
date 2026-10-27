import { makeThreadPauseTransport } from "./ThreadPauseTransport.ts";
import { makeThreadFinalSaveTransport } from "./ThreadFinalSaveTransport.ts";
import { makeThreadLocalEnrollmentTransport } from "./ThreadLocalEnrollmentTransport.ts";
import { makeThreadMoveTransport } from "./ThreadMoveTransport.ts";
import {
  ThreadCheckpointPublishError,
  type ThreadCheckpointTransport,
} from "./ThreadCheckpointPublisher.ts";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { ThreadCommandSyncError, type ThreadCommandTransport } from "./ThreadCommandSync.ts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  ThreadHistorySyncError,
  type ThreadHistoryOwner,
  type ThreadHistoryTransport,
} from "./ThreadHistorySync.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { RELAY_URL_SECRET, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import {
  ThreadExecutionRelayError,
  type ThreadExecutionAuthority,
} from "./ThreadExecutionRelay.ts";

/** Credentials are loaded for each admission so unlinking/rotation takes effect immediately. */
export const makeThreadExecutionAuthority = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const environment = yield* ServerEnvironmentIdentity;
  const httpClient = yield* HttpClient.HttpClient;
  const configuredClient = Effect.fnUntraced(function* (
    work: ThreadHistoryOwner,
    operation: "admit" | "complete" | "history" | "inbox",
    transformRequest?: (
      request: HttpClientRequest.HttpClientRequest,
    ) => HttpClientRequest.HttpClientRequest,
  ) {
    const missing = () =>
      new ThreadExecutionRelayError({
        threadId: work.threadId,
        operation,
        detail: "The thread's relay connection is unavailable or belongs to another environment.",
      });
    const vm = yield* readInstalledThreadVm().pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.mapError(missing),
    );
    if (vm) {
      const environmentId = yield* environment.getEnvironmentId;
      if (
        vm.environmentId !== environmentId ||
        work.environmentId !== environmentId ||
        vm.scope.threadId !== work.threadId ||
        vm.scope.generation !== work.generation ||
        vm.relayUrl !== normalizeSecureRelayUrl(work.relayUrl)
      )
        return yield* missing();
      return yield* makeExecutorRelayApiClient(
        {
          url: vm.relayUrl,
          issuer: vm.relayIssuer,
          environmentCredential: vm.environmentCredential,
        },
        transformRequest,
      ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    }
    const [storedUrl, credential, environmentId] = yield* Effect.all([
      secrets.get(RELAY_URL_SECRET),
      secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      environment.getEnvironmentId,
    ]).pipe(Effect.mapError(missing));
    if (
      Option.isNone(storedUrl) ||
      Option.isNone(credential) ||
      environmentId !== work.environmentId
    )
      return yield* missing();
    const url = normalizeSecureRelayUrl(new TextDecoder().decode(storedUrl.value));
    const environmentCredential = new TextDecoder().decode(credential.value);
    if (!url || url !== normalizeSecureRelayUrl(work.relayUrl) || !environmentCredential.trim())
      return yield* missing();
    return yield* makeExecutorRelayApiClient(
      { url, issuer: url, environmentCredential },
      transformRequest,
    ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  });
  const authority: ThreadExecutionAuthority = {
    admit: Effect.fn("ThreadExecutionAuthority.admit")(function* (work) {
      const client = yield* configuredClient(work, "admit");
      return yield* client.threadEnvironment
        .admitWork({
          params: {
            environmentId: EnvironmentId.make(work.environmentId),
            threadId: ThreadId.make(work.threadId),
          },
          payload: { generation: work.generation, workId: work.workId },
        })
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new ThreadExecutionRelayError({
                threadId: work.threadId,
                operation: "admit",
                detail:
                  "The relay did not confirm permission to start this work. It has not been started.",
              }),
          ),
        );
    }),
    complete: Effect.fn("ThreadExecutionAuthority.complete")(function* (work) {
      const client = yield* configuredClient(work, "complete");
      yield* client.threadEnvironment
        .completeWork({
          params: {
            environmentId: EnvironmentId.make(work.environmentId),
            threadId: ThreadId.make(work.threadId),
          },
          payload: { generation: work.generation, workId: work.workId },
        })
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new ThreadExecutionRelayError({
                threadId: work.threadId,
                operation: "complete",
                detail: "Work has stopped here, but its completion has not reached the relay yet.",
              }),
          ),
        );
    }),
  };
  const history: ThreadHistoryTransport = {
    append: Effect.fn("ThreadExecutionAuthority.appendHistory")(function* (owner, event) {
      yield* Effect.gen(function* () {
        const client = yield* configuredClient(owner, "history");
        yield* client.threadEnvironment.appendHistory({
          params: {
            environmentId: EnvironmentId.make(owner.environmentId),
            threadId: ThreadId.make(owner.threadId),
          },
          payload: { generation: owner.generation, event },
        });
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          () =>
            new ThreadHistorySyncError({
              threadId: owner.threadId,
              detail: "Thread history has not reached the relay yet. Its local copy is retained.",
            }),
        ),
      );
    }),
    confirmThrough: Effect.fn("ThreadExecutionAuthority.confirmHistoryThrough")(
      function* (owner, sourceSequence) {
        yield* Effect.gen(function* () {
          const client = yield* configuredClient(owner, "history");
          yield* client.threadEnvironment.confirmHistoryThrough({
            params: {
              environmentId: EnvironmentId.make(owner.environmentId),
              threadId: ThreadId.make(owner.threadId),
            },
            payload: { generation: owner.generation, sourceSequence },
          });
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new ThreadHistorySyncError({
                threadId: owner.threadId,
                detail: "Thread history scan is waiting for relay confirmation.",
              }),
          ),
        );
      },
    ),
  };
  const inboxError = (threadId: string) =>
    new ThreadCommandSyncError({
      threadId,
      detail: "Relay command delivery is waiting for acknowledgement.",
    });
  const commands: ThreadCommandTransport = {
    next: Effect.fn("ThreadExecutionAuthority.nextCommand")(function* (owner) {
      return yield* Effect.gen(function* () {
        const client = yield* configuredClient(owner, "inbox");
        return yield* client.threadEnvironment.nextCommand({
          params: {
            environmentId: EnvironmentId.make(owner.environmentId),
            threadId: ThreadId.make(owner.threadId),
          },
          payload: { generation: owner.generation },
        });
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => inboxError(owner.threadId)),
      );
    }),
    acknowledge: Effect.fn("ThreadExecutionAuthority.acknowledgeCommand")(
      function* (owner, commandId, receipt, commandReceipt) {
        yield* Effect.gen(function* () {
          const client = yield* configuredClient(owner, "inbox");
          yield* client.threadEnvironment.acknowledgeCommand({
            params: {
              environmentId: EnvironmentId.make(owner.environmentId),
              threadId: ThreadId.make(owner.threadId),
            },
            payload: {
              generation: owner.generation,
              commandId,
              receipt,
              ...(commandReceipt === undefined ? {} : { commandReceipt }),
            },
          });
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(() => inboxError(owner.threadId)),
        );
      },
    ),
  };
  const checkpointFailure = (threadId: string) =>
    new ThreadCheckpointPublishError({
      threadId,
      detail: "The relay has not confirmed this checkpoint; its local copy is retained.",
    });
  const checkpoints: ThreadCheckpointTransport = {
    upload: Effect.fn("ThreadExecutionAuthority.uploadCheckpointArtifact")(
      function* (owner, input, body) {
        const client = yield* configuredClient(
          owner,
          "history",
          HttpClientRequest.bodyStream(body, {
            contentType: "application/octet-stream",
            contentLength: input.sizeBytes,
          }),
        ).pipe(Effect.mapError(() => checkpointFailure(owner.threadId)));
        return yield* client.threadArtifacts
          .upload({
            params: {
              environmentId: EnvironmentId.make(owner.environmentId),
              threadId: ThreadId.make(owner.threadId),
              artifactId: input.artifactId,
            },
            query: {
              generation: owner.generation,
              operationId: input.operationId,
              kind: input.kind,
              sha256: input.sha256,
              sizeBytes: input.sizeBytes,
            },
          })
          .pipe(Effect.mapError(() => checkpointFailure(owner.threadId)));
      },
    ),
    publishNative: Effect.fn("ThreadExecutionAuthority.publishNativeCheckpoint")(
      function* (owner, input) {
        const client = yield* configuredClient(owner, "history").pipe(
          Effect.mapError(() => checkpointFailure(owner.threadId)),
        );
        return yield* client.threadArtifacts
          .publishNative({
            params: {
              environmentId: EnvironmentId.make(owner.environmentId),
              threadId: ThreadId.make(owner.threadId),
            },
            payload: { generation: owner.generation, ...input },
          })
          .pipe(Effect.mapError(() => checkpointFailure(owner.threadId)));
      },
    ),
    publishAttachments: Effect.fn("ThreadExecutionAuthority.publishAttachmentCheckpoint")(
      function* (owner, input) {
        const client = yield* configuredClient(owner, "history").pipe(
          Effect.mapError(() => checkpointFailure(owner.threadId)),
        );
        return yield* client.threadArtifacts
          .publishAttachments({
            params: {
              environmentId: EnvironmentId.make(owner.environmentId),
              threadId: ThreadId.make(owner.threadId),
            },
            payload: { generation: owner.generation, ...input },
          })
          .pipe(Effect.mapError(() => checkpointFailure(owner.threadId)));
      },
    ),
  };
  const discoveryOwner = Effect.gen(function* () {
    const vm = yield* readInstalledThreadVm().pipe(
      Effect.provideService(ServerSecretStore, secrets),
    );
    const environmentId = yield* environment.getEnvironmentId;
    if (vm)
      return {
        environmentId,
        relayUrl: vm.relayUrl,
        threadId: vm.scope.threadId,
        generation: vm.scope.generation,
      };
    const url = yield* secrets.get(RELAY_URL_SECRET);
    if (Option.isNone(url)) return null;
    const relayUrl = normalizeSecureRelayUrl(new TextDecoder().decode(url.value));
    return relayUrl ? { environmentId, relayUrl, threadId: "", generation: 1 } : null;
  });
  return {
    ...authority,
    history,
    commands,
    checkpoints,
    discoveryOwner,
    pauses: makeThreadPauseTransport((owner) => configuredClient(owner, "history")),
    finalSaves: makeThreadFinalSaveTransport((owner) => configuredClient(owner, "history")),
    enrollment: makeThreadLocalEnrollmentTransport((owner) => configuredClient(owner, "history")),
    moves: makeThreadMoveTransport(
      (owner) => configuredClient(owner, "history"),
      checkpoints.upload,
    ),
  };
});
