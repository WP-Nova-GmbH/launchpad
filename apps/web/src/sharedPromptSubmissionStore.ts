import {
  ClientOrchestrationCommand,
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { randomUUID } from "./lib/utils";

const STORAGE_KEY = "t3.shared-prompt-submissions.v1";
let accountId: string | null = null;
const storagePrefix = () => `${STORAGE_KEY}:${encodeURIComponent(accountId ?? "local")}:`;
const storageKey = (commandId: CommandId) => `${storagePrefix()}${commandId}`;
const StoredSubmission = Schema.Struct({
  environmentId: EnvironmentId,
  command: ClientOrchestrationCommand,
  displayThreadId: Schema.optional(ThreadId),
  sharedPreparation: Schema.optional(Schema.Boolean),
  rejection: Schema.optional(Schema.String),
  awaitingSend: Schema.optional(Schema.Boolean),
});
const decode = Schema.decodeUnknownSync(StoredSubmission);
export type SharedPromptSubmission = typeof StoredSubmission.Type;

function read(): ReadonlyArray<SharedPromptSubmission> {
  try {
    const entries: SharedPromptSubmission[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(storagePrefix())) continue;
      try {
        entries.push(decode(JSON.parse(localStorage.getItem(key) ?? "null")));
      } catch {
        // One unreadable record must not hide other saved prompts.
      }
    }
    return entries.sort((a, b) => {
      const left = "createdAt" in a.command ? a.command.createdAt : "";
      const right = "createdAt" in b.command ? b.command.createdAt : "";
      return left.localeCompare(right);
    });
  } catch {
    return [];
  }
}

export const useSharedPromptSubmissions = create<{
  entries: ReadonlyArray<SharedPromptSubmission>;
}>(() => ({ entries: read() }));

function write(entry: SharedPromptSubmission) {
  // Persist before dispatch. A storage failure must leave the composer intact.
  // Independent keys prevent simultaneous browser tabs overwriting each other.
  localStorage.setItem(storageKey(entry.command.commandId), JSON.stringify(entry));
  useSharedPromptSubmissions.setState({ entries: read() });
}

export function retainSharedPromptSubmission(
  environmentId: EnvironmentId,
  input: StartThreadTurnInput,
  sharedPreparation = false,
) {
  const { expectedAccountId, ...commandInput } = input;
  if (expectedAccountId !== undefined && expectedAccountId !== accountId) {
    throw new Error(
      "Your account changed before this prompt was sent. Send it again from the current account.",
    );
  }
  const command = {
    ...commandInput,
    type: "thread.turn.start" as const,
    commandId: input.commandId ?? CommandId.make(`prompt-${input.message.messageId}`),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const submission = read().find((entry) => entry.command.commandId === command.commandId) ?? {
    environmentId,
    command,
    sharedPreparation,
  };
  const sending = submission.awaitingSend ? { ...submission, awaitingSend: false } : submission;
  write(sending);
  return sending;
}

export function rejectSharedPromptSubmission(commandId: CommandId, detail: string) {
  const original = read().find((entry) => entry.command.commandId === commandId);
  if (original && original.rejection !== detail) write({ ...original, rejection: detail });
}

/** Move the recovery card before rotating a rejected draft's route; retain its original receipt IDs. */
export function relocateSharedPromptSubmissions(
  environmentId: EnvironmentId,
  from: ThreadId,
  to: ThreadId,
) {
  for (const entry of read()) {
    if (
      entry.environmentId === environmentId &&
      "threadId" in entry.command &&
      (entry.displayThreadId ?? entry.command.threadId) === from
    )
      write({ ...entry, displayThreadId: to });
  }
}

export function forgetSharedPromptSubmission(commandId: CommandId) {
  localStorage.removeItem(storageKey(commandId));
  useSharedPromptSubmissions.setState({ entries: read() });
}

export function hasSharedPromptSubmission(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: string,
) {
  return useSharedPromptSubmissions
    .getState()
    .entries.some(
      (entry) =>
        entry.environmentId === environmentId &&
        entry.command.type === "thread.turn.start" &&
        entry.command.threadId === threadId &&
        entry.command.message.messageId === messageId,
    );
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith(storagePrefix()) || event.key === null)
      useSharedPromptSubmissions.setState({ entries: read() });
  });
}

/** A rejected command is final; an explicitly revised draft needs fresh identities. */
export function reviseRejectedSharedPrompt(
  commandId: CommandId,
  text: string,
  options?: {
    sharedPreparation?: boolean;
  },
) {
  const entries = read();
  const original = entries.find((entry) => entry.command.commandId === commandId);
  if (
    !original ||
    original.command.type !== "thread.turn.start" ||
    original.rejection === undefined
  )
    return;
  const { rejection: _rejection, ...retained } = original;
  const next = {
    ...retained,
    displayThreadId: original.displayThreadId ?? original.command.threadId,
    sharedPreparation: options?.sharedPreparation ?? original.sharedPreparation ?? false,
    awaitingSend: true,
    command: {
      ...original.command,
      commandId: CommandId.make(randomUUID()),
      ...(original.command.bootstrap?.createThread
        ? { threadId: ThreadId.make(randomUUID()) }
        : {}),
      message: {
        ...original.command.message,
        messageId: MessageId.make(randomUUID()),
        text,
      },
      createdAt: new Date().toISOString(),
    },
  };
  write(next);
  forgetSharedPromptSubmission(commandId);
}

export function setSharedPromptSubmissionAccount(nextAccountId: string | null) {
  if (accountId === nextAccountId) return;
  accountId = nextAccountId;
  useSharedPromptSubmissions.setState({ entries: read() });
}
