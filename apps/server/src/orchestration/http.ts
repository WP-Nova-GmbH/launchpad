import { RepositoryAccess, stampCommandAuthor } from "../auth/RepositoryAccess.ts";
import {
  authorizeOrchestrationCommand,
  replayAuthorizedOrchestrationCommand,
} from "../auth/CommandReceiptAccess.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  failEnvironmentScopeRequired,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { makeCreationDispatcher, makeDeletionDispatcher } from "./dispatchDeletion.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const dispatchDeletion = yield* makeDeletionDispatcher;
    const dispatchCreation = yield* makeCreationDispatcher;
    const access = yield* RepositoryAccess;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* access
            .requireMember(actor)
            .pipe(Effect.catch(() => failEnvironmentScopeRequired(AuthOrchestrationReadScope)));
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery.getCommandReadModel().pipe(
            Effect.flatMap((snapshot) =>
              access.projectIds(actor).pipe(
                Effect.map((ids) => ({
                  ...snapshot,
                  projects: snapshot.projects.filter((p) => ids === undefined || ids.has(p.id)),
                  threads: snapshot.threads.filter(
                    (t) => ids === undefined || ids.has(t.projectId),
                  ),
                })),
              ),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* access
            .requireMember(actor)
            .pipe(Effect.catch(() => failEnvironmentScopeRequired(AuthOrchestrationReadScope)));
          return yield* projectionSnapshotQuery.getShellSnapshot().pipe(
            Effect.flatMap((snapshot) =>
              access.projectIds(actor).pipe(
                Effect.map((ids) => ({
                  ...snapshot,
                  projects: snapshot.projects.filter((p) => ids === undefined || ids.has(p.id)),
                  threads: snapshot.threads.filter(
                    (t) => ids === undefined || ids.has(t.projectId),
                  ),
                })),
              ),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* access
            .requireMember(actor)
            .pipe(Effect.catch(() => failEnvironmentScopeRequired(AuthOrchestrationReadScope)));
          const anchor = (yield* access.status).enabled
            ? yield* access.withFence(
                Effect.gen(function* () {
                  const anchor = yield* projectionSnapshotQuery.getThreadSubscriptionAnchor(
                    args.params.threadId,
                  );
                  if (Option.isNone(anchor))
                    return yield* failEnvironmentNotFound("thread_not_found");
                  yield* access.requireProject(actor, anchor.value.projectId);
                  return anchor.value;
                }).pipe(Effect.catch(() => failEnvironmentNotFound("thread_not_found"))),
              )
            : undefined;
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
              anchor?.creationSequence,
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(
            snapshot.value,
            args.payload.reasoningMessages === "true",
          );
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const replay = yield* access
            .withFence(replayAuthorizedOrchestrationCommand(actor, args.payload))
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
          if (Option.isSome(replay)) return replay.value;
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            projectCloneTracker,
            args.payload,
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          const normalizedCommand = stampCommandAuthor(
            yield* normalizeDispatchCommand(args.payload).pipe(
              Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
            ),
            actor,
          );
          const result = yield* Effect.gen(function* () {
            if (
              normalizedCommand.type === "thread.delete" ||
              normalizedCommand.type === "project.delete"
            )
              return yield* dispatchDeletion(actor, normalizedCommand);
            if (
              normalizedCommand.type === "thread.create" ||
              (normalizedCommand.type === "thread.prompt.enqueue" &&
                normalizedCommand.bootstrap?.createThread)
            )
              return yield* dispatchCreation(actor, normalizedCommand);
            return yield* access.withFence(
              authorizeOrchestrationCommand(actor, normalizedCommand).pipe(
                Effect.andThen(orchestrationEngine.dispatch(normalizedCommand)),
              ),
            );
          }).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          yield* ProjectCloneTracker.discardCloneForDeletedProject(
            projectCloneTracker,
            normalizedCommand,
          );
          return result;
        }),
      );
  }),
);
