import { useClerk } from "@clerk/react";

import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";

export const T3_CONNECT_SIGN_IN_ERROR = "Could not load Launchpad Connect sign-in.";

export function retryT3ConnectSignIn() {
  window.location.reload();
}

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const status = clerk.status === "error" ? "error" : clerk.loaded ? "ready" : "loading";
  const openAuthPrompt = () => {
    if (!clerk.loaded || clerk.status === "error") return;
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  };
  return { status, openAuthPrompt } as const;
}
