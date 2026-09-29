import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type CommandId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
} from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { RepositoryAccess, type RepositoryActor } from "./RepositoryAccess.ts";
import { OrchestrationCommandPreviouslyRejectedError } from "../orchestration/Errors.ts";

const denied = () =>
  new EnvironmentAuthorizationError({
    message: "The command receipt is unavailable for this repository.",
    requiredScope: AuthOrchestrationReadScope,
  });

const receiptProjectScope = Effect.fn("CommandReceiptAccess.projectScope")(function* (
  receipt: OrchestrationCommandReceipt,
) {
  if (receipt.projectId != null) return receipt.projectId;
  if (receipt.aggregateKind === "project") return receipt.aggregateId as ProjectId;
  const threads = yield* ProjectionThreadRepository;
  const thread = yield* threads.getById({ threadId: receipt.aggregateId as ThreadId });
  if (Option.isNone(thread)) return undefined;
  const events = yield* OrchestrationEventStore;
  const recreated = yield* events.hasEventAfter({
    aggregateKind: "thread",
    aggregateId: receipt.aggregateId,
    type: "thread.created",
    sequenceExclusive: receipt.resultSequence,
  });
  return recreated ? undefined : thread.value.projectId;
});

const authorizeReceipt = Effect.fn("CommandReceiptAccess.authorizeReceipt")(function* (
  actor: RepositoryActor,
  receipt: OrchestrationCommandReceipt,
  assertedProjectId?: ProjectId,
) {
  const access = yield* RepositoryAccess;
  yield* access.requireMember(actor);
  if (!(yield* access.status).enabled) return true;
  const projectId = yield* receiptProjectScope(receipt);
  if (projectId === undefined) return false;
  if (assertedProjectId !== undefined && assertedProjectId !== projectId) return yield* denied();
  yield* access.requirePersistedProject(actor, projectId);
  return true;
});

const authorizeCommandReceipt = Effect.fn("CommandReceiptAccess.authorizeCommandReceipt")(
  function* (
    actor: RepositoryActor,
    command: OrchestrationCommand | ClientOrchestrationCommand,
    receipt: OrchestrationCommandReceipt,
  ) {
    const threadId = "threadId" in command ? command.threadId : undefined;
    const kind = threadId === undefined ? "project" : "thread";
    const id = threadId ?? ("projectId" in command ? command.projectId : undefined);
    if (receipt.aggregateKind !== kind || receipt.aggregateId !== id) return yield* denied();
    const assertedProjectId =
      "projectId" in command
        ? command.projectId
        : command.type === "thread.prompt.enqueue"
          ? command.bootstrap?.createThread?.projectId
          : undefined;
    if (!(yield* authorizeReceipt(actor, receipt, assertedProjectId))) return yield* denied();
  },
);

/** Caller holds the policy fence. Replays do not need old upload bytes or workspace paths. */
export const replayAuthorizedOrchestrationCommand = Effect.fn("CommandReceiptAccess.replay")(
  function* (actor: RepositoryActor, command: OrchestrationCommand | ClientOrchestrationCommand) {
    const access = yield* RepositoryAccess;
    yield* access.requireMember(actor);
    const receipts = yield* OrchestrationCommandReceiptRepository;
    const receipt = yield* receipts.getByCommandId({ commandId: command.commandId });
    if (Option.isNone(receipt)) return Option.none<{ readonly sequence: number }>();
    yield* authorizeCommandReceipt(actor, command, receipt.value);
    if (receipt.value.status === "rejected")
      return yield* new OrchestrationCommandPreviouslyRejectedError({
        commandId: command.commandId,
        detail: receipt.value.error ?? "Previously rejected.",
      });
    return Option.some({ sequence: receipt.value.resultSequence });
  },
);

/** Caller holds the policy fence through the read/response or dispatch. */
export const readAuthorizedCommandReceipt = Effect.fn("CommandReceiptAccess.read")(function* (
  actor: RepositoryActor,
  input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly projectId?: ProjectId | undefined;
  },
) {
  const access = yield* RepositoryAccess;
  yield* access.requireMember(actor);
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const receipt = yield* receipts.getByCommandId(input);
  if (
    Option.isNone(receipt) ||
    receipt.value.aggregateKind !== "thread" ||
    receipt.value.aggregateId !== input.threadId
  )
    return Option.none<OrchestrationCommandReceipt>();
  return (yield* authorizeReceipt(actor, receipt.value, input.projectId))
    ? receipt
    : Option.none<OrchestrationCommandReceipt>();
});

/** Authorize persisted replay scope before the engine can return an old receipt. */
export const authorizeOrchestrationCommand = Effect.fn("CommandReceiptAccess.authorizeCommand")(
  function* (actor: RepositoryActor, command: OrchestrationCommand) {
    const access = yield* RepositoryAccess;
    if (!(yield* access.status).enabled) return yield* access.requireCommand(actor, command);
    yield* access.requireMember(actor);
    const receipts = yield* OrchestrationCommandReceiptRepository;
    const receipt = yield* receipts.getByCommandId({ commandId: command.commandId });
    const threadId = "threadId" in command ? command.threadId : undefined;
    const bootstrapProjectId =
      command.type === "thread.create"
        ? command.projectId
        : command.type === "thread.prompt.enqueue"
          ? command.bootstrap?.createThread?.projectId
          : undefined;
    if (Option.isSome(receipt)) {
      yield* authorizeCommandReceipt(actor, command, receipt.value);
      return;
    }
    if (threadId !== undefined && bootstrapProjectId !== undefined) {
      const threads = yield* ProjectionThreadRepository;
      const existing = yield* threads.getById({ threadId });
      if (Option.isSome(existing) && existing.value.deletedAt === null) {
        yield* access.requirePersistedProject(actor, existing.value.projectId);
        if (existing.value.projectId !== bootstrapProjectId) return yield* denied();
      }
    }
    yield* access.requireCommand(actor, command);
  },
);
