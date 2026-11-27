import { PersonalIssueTrackers } from "../settings/PersonalIssueTrackers";
import { UserButton, useAuth } from "@clerk/react";
import { LinkIcon, LogInIcon, ServerIcon, SmartphoneIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";
import {
  retryT3ConnectSignIn,
  T3_CONNECT_SIGN_IN_ERROR,
  useT3ConnectAuthPrompt,
} from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarAvatar />;
}

function ConfiguredT3ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      <UserButton.UserProfilePage
        label="Connections"
        labelIcon={<LinkIcon className="size-4" />}
        url="connections"
      >
        <PersonalIssueTrackers />
      </UserButton.UserProfilePage>
      <UserButton.UserProfilePage
        label="Mobile clients"
        labelIcon={<SmartphoneIcon className="size-4" />}
        url="mobile-clients"
      >
        <MobileClientsUserProfilePage />
      </UserButton.UserProfilePage>
      <UserButton.UserProfilePage
        label="Launchpad Connect"
        labelIcon={<ServerIcon className="size-4" />}
        url="t3-connect"
      >
        <T3ConnectUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isSignedIn } = useAuth();
  const { status, openAuthPrompt } = useT3ConnectAuthPrompt();

  if (isSignedIn || status === "loading") return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {status === "error" ? (
          <p role="alert" className="px-2 py-1 text-xs text-muted-foreground">
            {T3_CONNECT_SIGN_IN_ERROR}
          </p>
        ) : null}
        <SidebarMenuButton onClick={status === "error" ? retryT3ConnectSignIn : openAuthPrompt}>
          <LogInIcon />
          <span>{status === "error" ? "Retry sign-in" : "Sign in to Launchpad Connect"}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
