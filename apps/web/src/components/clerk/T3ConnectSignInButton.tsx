import type { ComponentProps } from "react";

import { Button } from "../ui/button";
import {
  retryT3ConnectSignIn,
  T3_CONNECT_SIGN_IN_ERROR,
  useT3ConnectAuthPrompt,
} from "./useT3ConnectAuthPrompt";

export function T3ConnectSignInButton(
  props: Pick<ComponentProps<typeof Button>, "size" | "variant">,
) {
  const { status, openAuthPrompt } = useT3ConnectAuthPrompt();

  if (status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-muted-foreground">
          {T3_CONNECT_SIGN_IN_ERROR}
        </p>
        <Button {...props} onClick={retryT3ConnectSignIn}>
          Retry sign-in
        </Button>
      </div>
    );
  }

  return (
    <Button {...props} disabled={status === "loading"} onClick={openAuthPrompt}>
      {status === "loading" ? "Loading sign-in…" : "Sign in"}
    </Button>
  );
}
