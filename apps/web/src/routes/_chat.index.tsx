import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderGit2Icon, LinkIcon, PlusIcon, RotateCcwIcon, ServerOffIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { APP_DISPLAY_NAME } from "~/branding";
import { useManagedRelayOrganizationCatalog } from "~/cloud/managedRelayState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { cn } from "~/lib/utils";
import { openCommandPalette } from "../commandPaletteBus";
import { resolveStartRouteMode } from "./_chat.index.logic";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();
  const organizationCatalog = useManagedRelayOrganizationCatalog();
  const startMode = resolveStartRouteMode({
    isHostedStatic: authGateState.status === "hosted-static",
    environmentCount: environments.length,
    organizationRepositoryCount: organizationCatalog.data?.repositories.length ?? 0,
    organizationProjectCount: organizationCatalog.data?.projects.length ?? 0,
    organizationCatalogPending: organizationCatalog.isPending,
    organizationCatalogError: organizationCatalog.error,
  });

  if (authGateState.status === "hosted-static" && !isReady) {
    return null;
  }
  if (startMode === "pending") {
    return null;
  }
  if (startMode === "onboarding") {
    return <HostedStaticOnboardingState />;
  }

  return <IndexDraftLanding organizationCatalog={organizationCatalog} />;
}

/**
 * Landing on the index route drops straight into a draft thread for the most
 * recently active project, so the first screen is a prompt instead of a dead
 * end. Falls back to an add-project hero when no project exists yet.
 */
function IndexDraftLanding({
  organizationCatalog,
}: {
  readonly organizationCatalog: ReturnType<typeof useManagedRelayOrganizationCatalog>;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
        : null,
    [bootstrapped, projects, threads],
  );

  useEffect(() => {
    if (mostRecentProject === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [handleNewThread, mostRecentProject, startState.retryRequest]);

  if (!bootstrapped) {
    return null;
  }
  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // First-run routing to the welcome wizard happens in FirstRunGate at the
  // root, before this route ever renders.
  return <OrganizationNoProjectsHero organizationCatalog={organizationCatalog} />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

/**
 * The add-project hero, extended with the organization's projects and
 * repositories so its work stays visible even while the machines holding it
 * are offline. With nothing organization-scoped to show it defers to the
 * stock hero.
 */
function OrganizationNoProjectsHero({
  organizationCatalog,
}: {
  readonly organizationCatalog: ReturnType<typeof useManagedRelayOrganizationCatalog>;
}) {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const { environments } = useEnvironments();
  const connectionByEnvironmentId = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          environment.connection.phase,
        ]),
      ),
    [environments],
  );
  const repositories = organizationCatalog.data?.repositories ?? [];
  const organizationProjects = organizationCatalog.data?.projects ?? [];
  const hasOrganizationCatalog = repositories.length > 0 || organizationProjects.length > 0;

  if (!hasOrganizationCatalog && !organizationCatalog.error) {
    return <NoProjectsHero />;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty size="hero" className="flex-1 overflow-y-auto">
          <div className="w-full max-w-2xl px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>What should we work on?</EmptyTitle>
              <EmptyDescription>
                {hasOrganizationCatalog
                  ? "Your organization work remains visible even when its machines are offline."
                  : "Add a project to start your first thread."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button size="sm" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
              </div>
            </EmptyHeader>

            {organizationProjects.length > 0 ? (
              <section className="mt-10 text-left" aria-labelledby="organization-projects-title">
                <h2
                  id="organization-projects-title"
                  className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                >
                  Organization projects
                </h2>
                <div className="overflow-hidden rounded-xl border border-border/65 bg-card/25">
                  {organizationProjects.map((project) => {
                    const isOnline =
                      connectionByEnvironmentId.get(project.environmentId) === "connected";
                    return (
                      <div
                        key={`${project.environmentId}:${project.projectId}`}
                        className="flex min-w-0 items-center gap-3 border-b border-border/50 px-3.5 py-3 last:border-b-0"
                      >
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground">
                          {isOnline ? (
                            <FolderGit2Icon className="size-4" />
                          ) : (
                            <ServerOffIcon className="size-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {project.title}
                          </div>
                          <div className="truncate text-xs text-muted-foreground/75">
                            {project.repositoryCanonicalKey ?? "Local project"} ·{" "}
                            {project.machineLabel}
                          </div>
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-full border px-2 py-0.5 text-3xs font-medium",
                            isOnline
                              ? "border-success/25 bg-success/8 text-success"
                              : "border-border/60 bg-muted/35 text-muted-foreground",
                          )}
                        >
                          {isOnline ? "Available" : "Offline"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {repositories.length > 0 ? (
              <section className="mt-7 text-left" aria-labelledby="organization-repositories-title">
                <h2
                  id="organization-repositories-title"
                  className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                >
                  Organization repositories
                </h2>
                <div className="overflow-hidden rounded-xl border border-border/65 bg-card/25">
                  {repositories.map(({ repository, role }) => (
                    <div
                      key={repository.repositoryId}
                      className="flex min-w-0 items-center gap-3 border-b border-border/50 px-3.5 py-3 last:border-b-0"
                    >
                      <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {repository.name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground/75">
                          {repository.canonicalKeys.join(" · ")}
                        </div>
                      </div>
                      <span className="shrink-0 text-3xs font-medium text-muted-foreground uppercase">
                        {role ?? organizationCatalog.data?.membership.role ?? "member"}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {organizationCatalog.error ? (
              <div className="mt-7 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <span>Couldn’t refresh organization work.</span>
                <Button variant="ghost" size="xs" onClick={organizationCatalog.refresh}>
                  <RotateCcwIcon className="size-3" />
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();
  const localEnvironmentOff = isLocalEnvironmentDisabled();
  const description = localEnvironmentOff
    ? "The local environment is turned off. Connect a remote environment, or turn the local environment back on in Connections."
    : cloudEnabled
      ? "Enable Launchpad Connect on that machine, then open Connections here to sign in with the same account. You can also add the machine using a pairing link."
      : "Open Connections and add that machine using its pairing link. This app must be able to reach it.";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle>Connect to a computer running Launchpad</EmptyTitle>
              <EmptyDescription>
                This app connects to Launchpad running on your computer or a server. Start the
                Launchpad desktop app or command-line server on that machine and keep it running.
              </EmptyDescription>
              <EmptyDescription>{description}</EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Open Connections
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
