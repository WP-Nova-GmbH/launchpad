import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createThreadVmActionController } from "@t3tools/client-runtime/relay/threadVmActionController";
export function useThreadVmActionJournal(
  ...input: Parameters<typeof createThreadVmActionController>
) {
  const [journal, session, relayUrl, submit] = input;
  const controller = useMemo(
    () => createThreadVmActionController(journal, session, relayUrl, submit),
    [journal, session, relayUrl, submit],
  );
  useEffect(controller.mount, [controller]);
  return {
    ...useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot),
    run: controller.run,
  };
}
