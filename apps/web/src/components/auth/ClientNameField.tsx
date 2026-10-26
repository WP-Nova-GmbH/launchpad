import { useAtomValue } from "@effect/atom-react";
import { suggestClientLabel, clientLabelAccountNameAtom } from "@t3tools/client-runtime/connection";
import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "../ui/input";
import { browserClientOs, browserFamily, browserDeviceType } from "../../connection/clientMetadata";

const KEY = "launchpad.lastClientLabel";
export function rememberClientLabel(label: string) {
  try {
    localStorage.setItem(KEY, label.trim());
  } catch {
    /* Storage can be disabled. */
  }
}
function rememberedLabel() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
export function useClientName() {
  const displayName = useAtomValue(clientLabelAccountNameAtom);
  const edited = useRef(false);
  const identity = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  };
  const os = browserClientOs(identity);
  const browser = browserFamily(identity.userAgent);
  const suggestion = suggestClientLabel({
    remembered: rememberedLabel(),
    displayName,
    deviceType: browserDeviceType(identity),
    os: os === "unknown" || os === "other" ? null : os,
    browser: browser === "unknown" || browser === "other" ? null : browser,
  });

  const [value, setValue] = useState(suggestion);
  useEffect(() => {
    if (!edited.current) setValue(suggestion);
  }, [suggestion]);
  const onChange = useCallback((next: string) => {
    edited.current = true;
    setValue(next);
  }, []);
  return [value, onChange] as const;
}
export function ClientNameField({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">Client name</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        maxLength={80}
        required
        disabled={disabled}
        placeholder="My phone"
        autoComplete="off"
      />
      <span className="block text-xs text-muted-foreground">
        A name for this device on this environment.
      </span>
    </label>
  );
}
