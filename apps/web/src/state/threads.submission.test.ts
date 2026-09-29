import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { threadEnvironment } from "./threads";
import {
  forgetSharedPromptSubmission,
  hasSharedPromptSubmission,
  setSharedPromptSubmissionAccount,
  useSharedPromptSubmissions,
} from "../sharedPromptSubmissionStore";

const environmentId = EnvironmentId.make("submission-environment");
const input = {
  threadId: ThreadId.make("submission-thread"),
  message: {
    messageId: MessageId.make("submission-message"),
    role: "user" as const,
    text: "Accepted prompt",
    attachments: [
      {
        type: "file" as const,
        id: "attachment",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      },
    ],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  setSharedPromptSubmissionAccount("submission-account");
  useSharedPromptSubmissions.setState({ entries: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function registry() {
  const result = AtomRegistry.make();
  vi.spyOn(result, "get").mockReturnValue({
    environment: { capabilities: { sharedPromptQueue: true, sharedPreparation: true } },
  });
  return result;
}

describe("shared startTurn ownership", () => {
  it.each([false, true])(
    "keeps invocation ownership after another tab cleans acceptance (delayed storage event: %s)",
    async (delayedEvent) => {
      const failed = AsyncResult.failure<never>(Cause.die(new Error("Connection lost")));
      let finishDispatch!: (value: typeof failed) => void;
      const dispatch = new Promise<typeof failed>((resolve) => {
        finishDispatch = resolve;
      });
      const enqueue = vi.spyOn(threadEnvironment.enqueuePrompt, "run").mockReturnValue(dispatch);
      vi.spyOn(threadEnvironment.getCommandReceipt, "run").mockResolvedValue(failed);
      const result = runAtomCommand(
        registry(),
        threadEnvironment.startTurn,
        { environmentId, input },
        { reportFailure: false, reportDefect: false },
      );

      // This is the same no-await boundary ChatView uses before background navigation.
      const submissionWasRetained = hasSharedPromptSubmission(
        environmentId,
        input.threadId,
        input.message.messageId,
      );
      expect(submissionWasRetained).toBe(true);
      const saved = useSharedPromptSubmissions.getState().entries[0]!;
      expect(
        saved.command.type === "thread.turn.start" && saved.command.message.attachments,
      ).toEqual(input.message.attachments);
      if (delayedEvent) {
        storage.clear();
      } else {
        forgetSharedPromptSubmission(saved.command.commandId);
      }
      finishDispatch(failed);
      expect((await result)._tag).toBe("Failure");
      if (delayedEvent) useSharedPromptSubmissions.setState({ entries: [] });
      expect(
        hasSharedPromptSubmission(environmentId, input.threadId, input.message.messageId),
      ).toBe(false);
      expect(submissionWasRetained).toBe(true);
      expect(enqueue).toHaveBeenCalledOnce();
      // A fresh renderer sees no recovery work and cannot replay the accepted command.
      setSharedPromptSubmissionAccount("other-account");
      setSharedPromptSubmissionAccount("submission-account");
      expect(useSharedPromptSubmissions.getState().entries).toEqual([]);
    },
  );

  it("does not take ownership or dispatch if journal persistence fails", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    const enqueue = vi.spyOn(threadEnvironment.enqueuePrompt, "run");
    const result = runAtomCommand(
      registry(),
      threadEnvironment.startTurn,
      { environmentId, input },
      { reportFailure: false, reportDefect: false },
    );
    expect(hasSharedPromptSubmission(environmentId, input.threadId, input.message.messageId)).toBe(
      false,
    );
    expect((await result)._tag).toBe("Failure");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
