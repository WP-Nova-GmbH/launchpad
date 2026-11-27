import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";

declare const __T3CODE_DESKTOP_CLERK_UI_URL__: string;

/**
 * Electron half of the managed-auth boundary. The Electron provider statically
 * bundles the full clerk-js runtime, so this module must only ever load
 * lazily, and only inside the desktop shell — importing it eagerly would put
 * clerk-js back into every client's startup graph.
 */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  // The Electron SDK reads this option at runtime but omits it from the provider type.
  const clerkUi = {
    __internal_clerkUIUrl: new URL(__T3CODE_DESKTOP_CLERK_UI_URL__, window.location.href).href,
  };

  return (
    <ClerkProvider
      appearance={clerkAppearance}
      publishableKey={publishableKey}
      passkeys={passkeys}
      {...clerkUi}
    >
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
