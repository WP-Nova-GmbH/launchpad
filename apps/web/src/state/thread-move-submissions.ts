import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
export const threadMoveRelayUrl = () =>
  normalizeSecureRelayUrl(resolveCloudPublicConfig().relayUrl ?? "");
import { createThreadMoveSubmissionJournal } from "@t3tools/client-runtime/relay/threadMoveSubmission";

export const portableThreadIntentStorage = {
  read: async (key) => localStorage.getItem(key),
  write: async (key, value) => {
    localStorage.setItem(key, value);
  },
  remove: async (key) => {
    localStorage.removeItem(key);
  },
  withLock: (key, action) => {
    if (!navigator.locks)
      return Promise.reject(
        new Error("This browser cannot safely save a move. Use a current browser or desktop app."),
      );
    return navigator.locks.request(key, action);
  },
} satisfies import("@t3tools/client-runtime/relay/threadMoveSubmission").ThreadMoveSubmissionStorage;

export const threadMoveSubmissions = createThreadMoveSubmissionJournal(portableThreadIntentStorage);
