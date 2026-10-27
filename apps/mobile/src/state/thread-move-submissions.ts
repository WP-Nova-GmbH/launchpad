import { createThreadMoveSubmissionJournal } from "@t3tools/client-runtime/relay/threadMoveSubmission";
import { writeFileAtomically } from "../lib/atomic-file";
import { resolveConfiguredRelayUrl } from "../lib/relayConfig";

export const threadMoveRelayUrl = () => resolveConfiguredRelayUrl();

async function fileFor(key: string) {
  const { digestStringAsync, CryptoDigestAlgorithm } = await import("expo-crypto");
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, "thread-move-submissions");
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, `${await digestStringAsync(CryptoDigestAlgorithm.SHA256, key)}.json`);
}
const locks = new Map<string, Promise<unknown>>();
export const portableThreadIntentStorage = {
  read: async (key) => {
    const file = await fileFor(key);
    return file.exists ? file.text() : null;
  },
  write: async (key, value) => writeFileAtomically(await fileFor(key), value),
  remove: async (key) => {
    const file = await fileFor(key);
    if (file.exists) file.delete();
  },
  withLock: (key, action) => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    locks.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (locks.get(key) === next) locks.delete(key);
      });
    return next;
  },
} satisfies import("@t3tools/client-runtime/relay/threadMoveSubmission").ThreadMoveSubmissionStorage;

export const threadMoveSubmissions = createThreadMoveSubmissionJournal(portableThreadIntentStorage);
