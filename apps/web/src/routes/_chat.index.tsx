import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderGit2Icon, LinkIcon, PlusIcon, RotateCcwIcon, ServerOffIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
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
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { resolveStartRouteMode } from "./_chat.index.logic";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments } = useEnvironments();
  const organizationCatalog = useManagedRelayOrganizationCatalog();
  const startMode = resolveStartRouteMode({
    isHostedStatic: authGateState.status === "hosted-static",
    environmentCount: environments.length,
    organizationRepositoryCount: organizationCatalog.data?.repositories.length ?? 0,
    organizationProjectCount: organizationCatalog.data?.projects.length ?? 0,
    organizationCatalogPending: organizationCatalog.isPending,
    organizationCatalogError: organizationCatalog.error,
  });

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
  return <NoProjectsHero organizationCatalog={organizationCatalog} />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function NoProjectsHero({
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

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1 overflow-y-auto">
          <div className="w-full max-w-2xl px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
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
                            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
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
                      <span className="shrink-0 text-[10px] font-medium text-muted-foreground uppercase">
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

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Sign in to Launchpad Connect to connect a linked environment through its managed tunnel, or add a reachable backend manually."
                  : "Add a reachable backend manually to start working from this browser."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  {cloudEnabled ? "Open Connections" : "Add environment"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
