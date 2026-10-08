import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  forgetSharedPromptSubmission,
  hasSharedPromptSubmission,
  retainSharedPromptSubmission,
  useSharedPromptSubmissions,
  setSharedPromptSubmissionAccount,
  reviseRejectedSharedPrompt,
  rejectSharedPromptSubmission,
  relocateSharedPromptSubmissions,
} from "./sharedPromptSubmissionStore";
const environmentId = EnvironmentId.make("environment");
const input = {
  threadId: ThreadId.make("thread"),
  message: {
    messageId: MessageId.make("message"),
    role: "user" as const,
    text: "Saved prompt",
    attachments: [],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: "2026-09-28T00:00:00Z",
};
let saved = new Map<string, string>();
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return saved.size;
    },
    key: (index: number) => Array.from(saved.keys())[index] ?? null,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  setSharedPromptSubmissionAccount(null);
  useSharedPromptSubmissions.setState({ entries: [] });
});
describe("shared prompt transport journal", () => {
  it("does not move an in-flight prompt into a different account's journal", () => {
    setSharedPromptSubmissionAccount("bob");
    expect(() =>
      retainSharedPromptSubmission(environmentId, { ...input, expectedAccountId: "alice" }),
    ).toThrow("account changed");
    expect(saved.size).toBe(0);
    const own = retainSharedPromptSubmission(environmentId, { ...input, expectedAccountId: "bob" });
    expect(own.command).not.toHaveProperty("expectedAccountId");
    expect(useSharedPromptSubmissions.getState().entries).toHaveLength(1);
  });
  it("retains both submissions when another browser tab writes at the same time", () => {
    const write = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementationOnce((key, value) => {
      retainSharedPromptSubmission(environmentId, {
        ...input,
        message: { ...input.message, messageId: MessageId.make("other-tab") },
      });
      write(key, value);
    });
    const original = retainSharedPromptSubmission(environmentId, input);
    expect(useSharedPromptSubmissions.getState().entries).toHaveLength(2);
    forgetSharedPromptSubmission(original.command.commandId);
    expect(useSharedPromptSubmissions.getState().entries).toHaveLength(1);
    expect(hasSharedPromptSubmission(environmentId, input.threadId, "other-tab")).toBe(true);
  });

  it("persists stable identities and recovers a lost ACK without a second submission", () => {
    const first = retainSharedPromptSubmission(environmentId, input);
    useSharedPromptSubmissions.setState({ entries: [] });
    const retry = retainSharedPromptSubmission(environmentId, {
      ...input,
      commandId: first.command.commandId,
    });
    expect(retry.command.commandId).toBe(first.command.commandId);
    expect(useSharedPromptSubmissions.getState().entries).toHaveLength(1);
    expect(hasSharedPromptSubmission(environmentId, input.threadId, input.message.messageId)).toBe(
      true,
    );
    forgetSharedPromptSubmission(first.command.commandId);
    expect(useSharedPromptSubmissions.getState().entries).toHaveLength(0);
  });
  it("isolates saved submissions between signed-in accounts", () => {
    setSharedPromptSubmissionAccount("alice");
    const alice = retainSharedPromptSubmission(environmentId, input);
    setSharedPromptSubmissionAccount("bob");
    expect(useSharedPromptSubmissions.getState().entries).toHaveLength(0);
    setSharedPromptSubmissionAccount("alice");
    expect(useSharedPromptSubmissions.getState().entries[0]?.command.commandId).toBe(
      alice.command.commandId,
    );
  });
  it("only creates fresh identities when the user revises a rejected prompt", () => {
    const original = retainSharedPromptSubmission(environmentId, input);
    reviseRejectedSharedPrompt(original.command.commandId, "Do not replay an unknown send");
    expect(useSharedPromptSubmissions.getState().entries[0]?.command.commandId).toBe(
      original.command.commandId,
    );
    rejectSharedPromptSubmission(original.command.commandId, "Rejected before acceptance");
    reviseRejectedSharedPrompt(original.command.commandId, "Revised prompt");
    const revised = useSharedPromptSubmissions.getState().entries[0];
    expect(revised?.command.commandId).not.toBe(original.command.commandId);
    expect(revised?.command.type === "thread.turn.start" && revised.command.message.text).toBe(
      "Revised prompt",
    );
    expect(revised?.awaitingSend).toBe(true);
  });
  it("keeps a rejected bootstrap reachable through route replacement without changing its receipt identity", () => {
    const attachment = {
      type: "file" as const,
      id: "pending-file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const original = retainSharedPromptSubmission(
      environmentId,
      {
        ...input,
        message: { ...input.message, attachments: [attachment] },
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project"),
            title: "Saved",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: input.createdAt,
          },
        },
      },
      true,
    );
    rejectSharedPromptSubmission(original.command.commandId, "Preparation was rejected");
    const replacement = ThreadId.make("new-draft-thread");
    relocateSharedPromptSubmissions(environmentId, input.threadId, replacement);
    const retained = useSharedPromptSubmissions.getState().entries[0]!;
    expect(retained.displayThreadId).toBe(replacement);
    expect(retained.command).toEqual(original.command);
    // The recovery card owns its payload; a separately edited composer is never overwritten.
    reviseRejectedSharedPrompt(original.command.commandId, "User's revised text", {
      sharedPreparation: true,
    });
    const revised = useSharedPromptSubmissions.getState().entries[0]!;
    expect(revised.displayThreadId).toBe(replacement);
    if (revised.command.type !== "thread.turn.start") throw new Error("Unexpected command");
    expect(revised.command.threadId).not.toBe(input.threadId);
    expect(revised.command.message.attachments).toEqual([attachment]);
    expect(revised.rejection).toBeUndefined();
    expect(revised.awaitingSend).toBe(true);
    retainSharedPromptSubmission(environmentId, revised.command, true);
    expect(useSharedPromptSubmissions.getState().entries[0]?.awaitingSend).toBe(false);
  });
  it("does not discard the original journal when saving a revised draft fails", () => {
    const original = retainSharedPromptSubmission(environmentId, input);
    rejectSharedPromptSubmission(original.command.commandId, "Rejected");
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => reviseRejectedSharedPrompt(original.command.commandId, "new text")).toThrow(
      "disk full",
    );
    expect(useSharedPromptSubmissions.getState().entries[0]?.command.commandId).toBe(
      original.command.commandId,
    );
  });
  it("does not upgrade a legacy ambiguous submission into an automatically retryable command", () => {
    const original = retainSharedPromptSubmission(environmentId, input, false);
    const retry = retainSharedPromptSubmission(
      environmentId,
      { ...input, commandId: original.command.commandId },
      true,
    );
    expect(retry.sharedPreparation).toBe(false);
  });
  it("does not claim transport ownership if persistence fails", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("Storage is full");
      },
    });
    expect(() => retainSharedPromptSubmission(environmentId, input)).toThrow("Storage is full");
    expect(hasSharedPromptSubmission(environmentId, input.threadId, input.message.messageId)).toBe(
      false,
    );
  });
});
