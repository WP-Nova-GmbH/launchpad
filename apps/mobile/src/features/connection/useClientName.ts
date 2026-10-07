import { useAtomValue } from "@effect/atom-react";
import { clientLabelAccountNameAtom, suggestClientLabel } from "@t3tools/client-runtime/connection";
import { useCallback, useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { authClientMetadata } from "../../lib/authClientMetadata";

const KEY = "launchpad.lastClientLabel";
export async function rememberClientLabel(label: string) {
  try {
    await SecureStore.setItemAsync(KEY, label.trim());
  } catch {
    /* Naming remains usable without local storage. */
  }
}
export function useClientName() {
  const displayName = useAtomValue(clientLabelAccountNameAtom);
  const [remembered, setRemembered] = useState<string | null>(null);
  const edited = useRef(false);
  const metadata = authClientMetadata();
  const suggestion = suggestClientLabel({
    remembered,
    displayName,
    deviceType: metadata.deviceType,
    os: metadata.os,
  });
  const [name, setName] = useState(suggestion);
  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(KEY).then(
      (value) => {
        if (active) setRemembered(value);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!edited.current) setName(suggestion);
  }, [suggestion]);
  const onChange = useCallback((value: string) => {
    edited.current = true;
    setName(value);
  }, []);
  return [name, onChange] as const;
}
