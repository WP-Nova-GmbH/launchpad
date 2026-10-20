import { createThreadVmActionJournal } from "@t3tools/client-runtime/relay/threadVmActionSubmission";
import { createThreadQueueControlJournal } from "@t3tools/client-runtime/relay/threadQueueControlSubmission";
import { portableThreadIntentStorage } from "./thread-move-submissions";
import {
  createPortableThreadLibraryAtoms,
  createPortableThreadChatCommand,
} from "@t3tools/client-runtime/relay/portableThreadLibrary";
import {
  createThreadVmControlAtoms,
  withPortableThreadDeletion,
} from "@t3tools/client-runtime/relay/threadVmControls";
import * as Crypto from "expo-crypto";
import { createPortableThreadCommandAtoms } from "@t3tools/client-runtime/relay/portableThreads";
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { orchestrationEnvironment } from "./orchestration";

export const portableThreadLibrary = createPortableThreadLibraryAtoms(connectionAtomRuntime);
export const threadVmActionJournal = createThreadVmActionJournal(portableThreadIntentStorage);
export const threadVmControls = createThreadVmControlAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
  portableThreadLibrary.routeAtom,
  (environmentId) => orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} }),
  (environmentId, threadId) => environmentThreadDetails.detailAtom({ environmentId, threadId }),
);

const baseThreadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);
export const threadEnvironment = {
  ...baseThreadEnvironment,
  delete: withPortableThreadDeletion(
    baseThreadEnvironment.delete,
    threadVmControls.action,
    threadVmActionJournal,
    threadVmControls.routeAtom,
    Crypto.randomUUID,
  ),
};
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}

export const portableThreadCommands = createPortableThreadCommandAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);

export const openPortableThreadChat = createPortableThreadChatCommand(connectionAtomRuntime);

export const threadQueueControlJournal = createThreadQueueControlJournal(
  portableThreadIntentStorage,
);
