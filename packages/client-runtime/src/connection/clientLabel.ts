import type { AuthClientMetadataDeviceType } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

export const clientLabelAccountNameAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);

/** Suggestions never override a label the connecting client has edited. */
export function suggestClientLabel(input: {
  remembered?: string | null;
  displayName?: string | null;
  deviceType?: AuthClientMetadataDeviceType;
  browser?: string | null;
  os?: string | null;
}): string {
  if (input.remembered?.trim()) return input.remembered.trim().slice(0, 80);
  const device =
    input.deviceType === "tablet"
      ? "Tablet"
      : input.deviceType === "mobile"
        ? "Phone"
        : input.deviceType === "desktop"
          ? "Computer"
          : null;
  if (input.displayName?.trim() && device)
    return `${input.displayName.trim()}'s ${device}`.slice(0, 80);
  return ([input.os, input.browser].filter(Boolean).join(" · ") || device || "").slice(0, 80);
}
