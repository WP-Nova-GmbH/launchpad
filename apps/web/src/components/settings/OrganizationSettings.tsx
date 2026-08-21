import {
  BuildingIcon,
  CopyIcon,
  FolderGit2Icon,
  ServerIcon,
  TrashIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  RelayInvitation,
  RelayMachine,
  RelayMachineRole,
  RelayOrgRole,
  RelayOrganizationMember,
  RelayRepositoryId,
  RelayRepositoryAccessEntry,
  RelayRepositoryRole,
  RelayRepositorySummary,
} from "@t3tools/contracts/relay";

import { GitHubIcon } from "../Icons";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useProjects } from "../../state/entities";
import { useOrganizationAdmin, type OrganizationAdminState } from "../../cloud/organizationAdmin";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import {
  hasMachineSettingUp,
  machineStatusPresentation,
  memberLabel,
  unregisteredCheckouts,
  visibleMachines,
} from "./OrganizationSettings.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const ORG_ROLE_LABELS: Readonly<Record<RelayOrgRole, string>> = {
  admin: "Admin",
  member: "Member",
};

const REPOSITORY_ROLE_LABELS: Readonly<Record<RelayRepositoryRole, string>> = {
  maintainer: "Maintainer",
  developer: "Developer",
};

const MACHINE_ROLE_LABELS: Readonly<Record<RelayMachineRole, string>> = {
  agent_executor: "Agent executor",
  review_host: "Review host",
};

/**
 * A line under a section heading saying what the section is for.
 *
 * Worth the space here: an organization is a set of records in the relay, and
 * nothing on this page puts code on a disk or a machine on the network. Saying
 * so is cheaper than someone looking for a registered repository under
 * Connections, Source Control, and Projects in turn.
 */
function SectionNote({ children }: { children: ReactNode }) {
  return <p className="px-3 pb-1 text-sm text-muted-foreground sm:px-4">{children}</p>;
}

function RoleBadge({ children }: { children: string }) {
  return (
    <Badge variant="secondary" className="font-normal">
      {children}
    </Badge>
  );
}

function OrganizationSection({ state }: { state: OrganizationAdminState }) {
  const membership = state.snapshot?.membership;
  const [name, setName] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const isAdmin = membership?.role === "admin";
  const pendingName = name.trim();

  if (!membership) return null;

  return (
    <SettingsSection
      id={searchableSetting("organization").id}
      title={searchableSetting("organization").title}
      icon={<BuildingIcon className="size-4 text-muted-foreground" />}
    >
      <SettingsRow
        title={membership.organization.name}
        description={`You are ${membership.role === "admin" ? "an admin" : "a member"} of this organization.`}
        control={<RoleBadge>{ORG_ROLE_LABELS[membership.role]}</RoleBadge>}
      />
      {isAdmin ? (
        <SettingsRow
          title="Name"
          description="What this organization is called across every client."
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Input
                nativeInput
                value={name}
                placeholder={membership.organization.name}
                aria-label="Organization name"
                onChange={(event) => setName(event.currentTarget.value)}
                className="w-full sm:w-56"
              />
              <Button
                size="sm"
                disabled={state.busy || pendingName.length === 0}
                onClick={() => {
                  void state.renameOrganization(pendingName).then((ok) => {
                    if (ok) setName("");
                  });
                }}
              >
                Rename
              </Button>
            </div>
          }
        />
      ) : null}
      <SettingsRow
        title="Join another organization"
        description="Paste an invitation link's token. Joining means leaving this organization, so it only works while this one is empty."
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Input
              nativeInput
              value={joinToken}
              placeholder="Invitation token"
              aria-label="Invitation token"
              onChange={(event) => setJoinToken(event.currentTarget.value)}
              className="w-full sm:w-56"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy || joinToken.trim().length === 0}
              onClick={() => {
                void state.acceptInvitation(joinToken.trim()).then((ok) => {
                  if (ok) setJoinToken("");
                });
              }}
            >
              Join
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}

function MembersSection({ state }: { state: OrganizationAdminState }) {
  const snapshot = state.snapshot;
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<RelayOrgRole>("member");
  const { copyToClipboard } = useCopyToClipboard({ target: "invitation token" });

  if (!snapshot) return null;
  const isAdmin = snapshot.membership.role === "admin";

  return (
    <SettingsSection
      id={searchableSetting("organization-members").id}
      title={searchableSetting("organization-members").title}
      icon={<UsersIcon className="size-4 text-muted-foreground" />}
    >
      <SectionNote>
        Everyone here shares this organization&apos;s repositories and connections. Admins manage
        people and repositories; members work in what they are given access to.
      </SectionNote>
      {snapshot.members.map((member) => {
        const isSelf = member.userId === snapshot.membership.userId;
        const label = memberLabel(member);
        const joined = `Joined ${member.joinedAt.slice(0, 10)}`;
        return (
          <SettingsRow
            key={member.userId}
            title={
              <span className="flex items-baseline gap-2">
                {label.primary}
                {isSelf ? <span className="text-xs text-muted-foreground">You</span> : null}
              </span>
            }
            description={label.secondary ? `${label.secondary} · ${joined}` : joined}
            control={
              isAdmin && !isSelf ? (
                <div className="flex items-center gap-2">
                  <Select
                    value={member.role}
                    onValueChange={(value) => {
                      if (typeof value !== "string") return;
                      void state.updateMemberRole({
                        userId: member.userId,
                        role: value as RelayOrgRole,
                      });
                    }}
                  >
                    <SelectTrigger className="w-32" aria-label={`Role for ${label.primary}`}>
                      <SelectValue>{ORG_ROLE_LABELS[member.role]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem hideIndicator value="member">
                        Member
                      </SelectItem>
                      <SelectItem hideIndicator value="admin">
                        Admin
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${label.primary}`}
                    disabled={state.busy}
                    onClick={() => void state.removeMember(member.userId)}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                </div>
              ) : (
                <RoleBadge>{ORG_ROLE_LABELS[member.role]}</RoleBadge>
              )
            }
          />
        );
      })}

      {isAdmin ? (
        <>
          <SettingsRow
            title="Invite someone"
            description="There is no email delivery yet, so the link comes back here for you to send."
            control={
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <Input
                  nativeInput
                  type="email"
                  value={email}
                  placeholder="person@example.com"
                  aria-label="Invitation email"
                  onChange={(event) => setEmail(event.currentTarget.value)}
                  className="w-full sm:w-56"
                />
                <Select
                  value={inviteRole}
                  onValueChange={(value) => {
                    if (typeof value === "string") setInviteRole(value as RelayOrgRole);
                  }}
                >
                  <SelectTrigger className="w-32" aria-label="Invitation role">
                    <SelectValue>{ORG_ROLE_LABELS[inviteRole]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="member">
                      Member
                    </SelectItem>
                    <SelectItem hideIndicator value="admin">
                      Admin
                    </SelectItem>
                  </SelectPopup>
                </Select>
                <Button
                  size="sm"
                  disabled={state.busy || email.trim().length === 0}
                  onClick={() => {
                    void state
                      .inviteMember({ email: email.trim(), role: inviteRole })
                      .then((ok) => {
                        if (ok) setEmail("");
                      });
                  }}
                >
                  Invite
                </Button>
              </div>
            }
          />
          {snapshot.invitations.map((invitation: RelayInvitation) => {
            const issued = state.issuedInvitations.find(
              (entry) => entry.invitation.invitationId === invitation.invitationId,
            );
            return (
              <SettingsRow
                key={invitation.invitationId}
                title={invitation.email}
                description={`Invited as ${ORG_ROLE_LABELS[invitation.role].toLowerCase()} · expires ${invitation.expiresAt.slice(0, 10)}${
                  issued ? "" : " · the token was only shown when it was created"
                }`}
                control={
                  <div className="flex items-center gap-2">
                    {issued ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copyToClipboard(issued.token, undefined)}
                      >
                        <CopyIcon className="size-3.5" />
                        Copy token
                      </Button>
                    ) : null}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Revoke the invitation for ${invitation.email}`}
                      disabled={state.busy}
                      onClick={() => void state.revokeInvitation(invitation.invitationId)}
                    >
                      <TrashIcon className="size-3.5" />
                    </Button>
                  </div>
                }
              />
            );
          })}
        </>
      ) : null}
    </SettingsSection>
  );
}

function RepositoryRow({
  entry,
  state,
  canConfigure,
  members,
  access,
}: {
  entry: RelayRepositorySummary;
  state: OrganizationAdminState;
  canConfigure: boolean;
  members: ReadonlyArray<RelayOrganizationMember>;
  access: ReadonlyArray<RelayRepositoryAccessEntry>;
}) {
  const [alias, setAlias] = useState("");
  const [grantUserId, setGrantUserId] = useState("");
  const [grantRole, setGrantRole] = useState<RelayRepositoryRole>("developer");
  const repositoryId = entry.repository.repositoryId as RelayRepositoryId;

  return (
    <SettingsRow
      title={entry.repository.name}
      description={
        entry.role ? `Your role: ${REPOSITORY_ROLE_LABELS[entry.role]}` : "No role of your own"
      }
      control={
        canConfigure ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${entry.repository.name}`}
            disabled={state.busy}
            onClick={() => void state.deleteRepository(repositoryId)}
          >
            <TrashIcon className="size-3.5" />
          </Button>
        ) : null
      }
    >
      <div className="space-y-2 pb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.repository.canonicalKeys.map((canonicalKey) => (
            <Badge key={canonicalKey} variant="outline" className="gap-1 font-mono text-[11px]">
              {canonicalKey}
              {canConfigure && entry.repository.canonicalKeys.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove ${canonicalKey}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => void state.removeAlias({ repositoryId, canonicalKey })}
                >
                  ×
                </button>
              ) : null}
            </Badge>
          ))}
        </div>
        {canConfigure ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              nativeInput
              value={alias}
              placeholder="host/owner/repo"
              aria-label={`Additional key for ${entry.repository.name}`}
              onChange={(event) => setAlias(event.currentTarget.value)}
              className="w-full sm:w-64"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy || alias.trim().length === 0}
              onClick={() => {
                void state
                  .addAlias({ repositoryId, canonicalKey: alias.trim().toLowerCase() })
                  .then((ok) => {
                    if (ok) setAlias("");
                  });
              }}
            >
              Add key
            </Button>
          </div>
        ) : null}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            Who can work in this repository
          </p>
          {access.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nobody yet. Admins reach every repository regardless.
            </p>
          ) : (
            access.map((grant) => (
              <div key={grant.userId} className="flex items-center justify-between gap-2 py-0.5">
                <span className="min-w-0 truncate text-sm">{memberLabel(grant).primary}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <RoleBadge>{REPOSITORY_ROLE_LABELS[grant.role]}</RoleBadge>
                  {canConfigure ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Revoke ${memberLabel(grant).primary}'s access to ${entry.repository.name}`}
                      disabled={state.busy}
                      onClick={() =>
                        void state.revokeAccess({ repositoryId, userId: grant.userId })
                      }
                    >
                      <TrashIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>
        {canConfigure ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={grantUserId}
              onValueChange={(value) => {
                if (typeof value === "string") setGrantUserId(value);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-64"
                aria-label={`Grant access to ${entry.repository.name}`}
              >
                <SelectValue>
                  {grantUserId
                    ? memberLabel(
                        members.find((member) => member.userId === grantUserId) ?? {
                          userId: grantUserId,
                          identity: null,
                        },
                      ).primary
                    : "Choose a member"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {members.map((member) => (
                  <SelectItem hideIndicator key={member.userId} value={member.userId}>
                    {memberLabel(member).primary}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Select
              value={grantRole}
              onValueChange={(value) => {
                if (typeof value === "string") setGrantRole(value as RelayRepositoryRole);
              }}
            >
              <SelectTrigger className="w-36" aria-label="Repository role">
                <SelectValue>{REPOSITORY_ROLE_LABELS[grantRole]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="developer">
                  Developer
                </SelectItem>
                <SelectItem hideIndicator value="maintainer">
                  Maintainer
                </SelectItem>
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy || grantUserId.length === 0}
              onClick={() => {
                void state
                  .grantAccess({ repositoryId, userId: grantUserId, role: grantRole })
                  .then((ok) => {
                    if (ok) setGrantUserId("");
                  });
              }}
            >
              Grant
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function useUnregisteredCheckouts(repositories: ReadonlyArray<RelayRepositorySummary>) {
  const projects = useProjects();
  return useMemo(() => unregisteredCheckouts(projects, repositories), [projects, repositories]);
}

/**
 * GitHub connection.
 *
 * The App is installed on GitHub, which redirects back here with an
 * `installation_id`; claiming it is what ties that installation to this
 * organization. Access then belongs to the organization rather than to whoever
 * installed it — the relay mints tokens per request, so nobody holds a GitHub
 * credential.
 */
function GithubSection({ state }: { state: OrganizationAdminState }) {
  const snapshot = state.snapshot;
  const isAdmin = snapshot?.membership.role === "admin";
  const connection = snapshot?.github.connection ?? null;
  const installUrl = snapshot?.github.installUrl ?? null;

  // GitHub sends the id in the query string on its way back from the install.
  useEffect(() => {
    if (!isAdmin || connection) return;
    const params = new URLSearchParams(window.location.search);
    const installationId = params.get("installation_id");
    if (!installationId) return;
    void state.connectGithub(installationId).then(() => {
      params.delete("installation_id");
      params.delete("setup_action");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}`,
      );
    });
  }, [connection, isAdmin, state]);

  if (!snapshot) return null;
  if (!installUrl && !connection) {
    // No GitHub App configured on this relay; the surface has nothing to offer.
    return null;
  }

  return (
    <SettingsSection
      id={searchableSetting("organization-github").id}
      title={searchableSetting("organization-github").title}
      icon={<GitHubIcon className="size-4 text-muted-foreground" />}
    >
      <SectionNote>
        Connecting installs an app on GitHub, which lets this organization see those repositories
        and register them without typing their addresses. The access belongs to the organization, so
        members share it and nobody needs their own GitHub token.
      </SectionNote>
      {connection ? (
        <SettingsRow
          title={connection.accountLogin}
          description={`Connected ${connection.connectedAt.slice(0, 10)}. Every member of this organization reaches these repositories; nobody needs their own GitHub token.`}
          control={
            isAdmin ? (
              <div className="flex items-center gap-2">
                {installUrl ? (
                  <Button size="sm" variant="outline" render={<a href={installUrl} />}>
                    Change repositories
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => void state.disconnectGithub()}
                >
                  Disconnect
                </Button>
              </div>
            ) : null
          }
        />
      ) : (
        <SettingsRow
          title="Connect GitHub"
          description="Install the app on a GitHub organization, or on just the repositories you choose. Access belongs to this organization afterwards, not to you."
          control={
            isAdmin && installUrl ? (
              <Button size="sm" render={<a href={installUrl} />}>
                Connect GitHub
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">Ask an admin to connect it.</span>
            )
          }
        />
      )}

      {connection && snapshot.githubRepositories.length > 0 ? (
        <div className="space-y-1 px-3 pt-1 sm:px-4">
          <p className="text-xs font-medium text-muted-foreground">
            Repositories this installation can see
          </p>
          {snapshot.githubRepositories.map((repository) => (
            <div key={repository.fullName} className="flex items-center justify-between gap-3 py-1">
              <span className="min-w-0 truncate font-mono text-xs">{repository.fullName}</span>
              {repository.registered ? (
                <Badge variant="secondary" className="shrink-0 font-normal">
                  Registered
                </Badge>
              ) : isAdmin ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={state.busy}
                  onClick={() =>
                    void state.registerRepository({
                      name: repository.name,
                      canonicalKey: repository.canonicalKey,
                    })
                  }
                >
                  Register
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </SettingsSection>
  );
}

function RepositoriesSection({ state }: { state: OrganizationAdminState }) {
  const snapshot = state.snapshot;
  const [name, setName] = useState("");
  const [canonicalKey, setCanonicalKey] = useState("");
  const unregistered = useUnregisteredCheckouts(snapshot?.repositories ?? []);

  if (!snapshot) return null;
  const isAdmin = snapshot.membership.role === "admin";

  return (
    <SettingsSection
      id={searchableSetting("organization-repositories").id}
      title={searchableSetting("organization-repositories").title}
      icon={<FolderGit2Icon className="size-4 text-muted-foreground" />}
    >
      <SectionNote>
        A repository here is the organization&apos;s record of a codebase, recognised by its git
        remote. Registering one does not check anything out — it decides who may work in it and lets
        any checkout on any machine be recognised as the same repository.
      </SectionNote>
      {snapshot.repositories.length === 0 ? (
        <Empty className="min-h-48">
          <EmptyMedia variant="icon">
            <FolderGit2Icon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No repositories yet</EmptyTitle>
            <EmptyDescription>
              A repository is recognised by the git remote of a checkout, reduced to
              <span className="font-mono"> host/owner/repo</span>. Mirrors and forks become extra
              keys on the same repository.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        snapshot.repositories.map((entry) => (
          <RepositoryRow
            key={entry.repository.repositoryId}
            entry={entry}
            state={state}
            canConfigure={isAdmin || entry.role === "maintainer"}
            members={snapshot.members}
            access={snapshot.access.get(entry.repository.repositoryId) ?? []}
          />
        ))
      )}
      {isAdmin
        ? unregistered.map((checkout) => (
            <SettingsRow
              key={checkout.canonicalKey}
              title={<span className="font-mono text-xs">{checkout.canonicalKey}</span>}
              description="Checked out on a machine you can see, but not part of this organization."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.busy}
                  onClick={() =>
                    void state.registerRepository({
                      name: checkout.suggestedName,
                      canonicalKey: checkout.canonicalKey,
                    })
                  }
                >
                  Register
                </Button>
              }
            />
          ))
        : null}
      {isAdmin ? (
        <SettingsRow
          title="Register a repository"
          description="Whoever registers it becomes its first maintainer."
          control={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Input
                nativeInput
                value={name}
                placeholder="Name"
                aria-label="Repository name"
                onChange={(event) => setName(event.currentTarget.value)}
                className="w-full sm:w-40"
              />
              <Input
                nativeInput
                value={canonicalKey}
                placeholder="github.com/acme/app"
                aria-label="Canonical key"
                onChange={(event) => setCanonicalKey(event.currentTarget.value)}
                className="w-full sm:w-64"
              />
              <Button
                size="sm"
                disabled={
                  state.busy || name.trim().length === 0 || canonicalKey.trim().length === 0
                }
                onClick={() => {
                  void state
                    .registerRepository({
                      name: name.trim(),
                      canonicalKey: canonicalKey.trim().toLowerCase(),
                    })
                    .then((ok) => {
                      if (ok) {
                        setName("");
                        setCanonicalKey("");
                      }
                    });
                }}
              >
                Register
              </Button>
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function MachineRow({
  machine,
  state,
  nowMs,
}: {
  machine: RelayMachine;
  state: OrganizationAdminState;
  nowMs: number;
}) {
  // Destroying a machine destroys thread history on it, so the trash icon
  // arms a second, labeled click instead of acting immediately.
  const [confirming, setConfirming] = useState(false);
  const isAdmin = state.snapshot?.membership.role === "admin";
  const status = machineStatusPresentation(machine, nowMs);
  const endpointHost = machine.endpoint ? new URL(machine.endpoint.httpBaseUrl).host : null;
  const timeline =
    machine.status === "ready" && machine.enrolledAt
      ? `Enrolled ${machine.enrolledAt.slice(0, 10)}`
      : `Provisioned ${machine.createdAt.slice(0, 10)}`;

  return (
    <SettingsRow
      title={
        <span className="flex items-baseline gap-2">
          {machine.label}
          <RoleBadge>{MACHINE_ROLE_LABELS[machine.role]}</RoleBadge>
        </span>
      }
      description={endpointHost ? `${timeline} · ${endpointHost}` : timeline}
      status={
        status.guidance ? <span className="block text-destructive">{status.guidance}</span> : null
      }
      control={
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <ConnectionStatusDot
              dotClassName={status.dotClassName}
              pingClassName={status.pingClassName}
            />
            {status.label}
          </span>
          {isAdmin && machine.status !== "deprovisioned" ? (
            confirming ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={state.busy}
                onBlur={() => setConfirming(false)}
                onClick={() => {
                  setConfirming(false);
                  void state.deprovisionMachine(machine.machineId);
                }}
              >
                Destroy machine
              </Button>
            ) : (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Destroy ${machine.label}`}
                disabled={state.busy}
                onClick={() => setConfirming(true)}
              >
                <TrashIcon className="size-3.5" />
              </Button>
            )
          ) : null}
        </div>
      }
    />
  );
}

function MachinesSection({ state }: { state: OrganizationAdminState }) {
  const snapshot = state.snapshot;
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<RelayMachineRole>("agent_executor");
  // A machine flips to ready on its own within a couple of minutes of being
  // provisioned. While one is in that window, the list keeps itself fresh —
  // asking the admin to reload the page would make the product look stuck.
  const nowMs = useRelativeTimeTick(30_000);
  const machines = visibleMachines(snapshot?.machines ?? []);
  const settingUp = hasMachineSettingUp(machines, nowMs);
  const { busy, loading, refresh } = state;
  useEffect(() => {
    if (!settingUp) return;
    const id = setInterval(() => {
      if (busy || loading) return;
      void refresh();
    }, 10_000);
    return () => clearInterval(id);
  }, [busy, loading, refresh, settingUp]);

  if (!snapshot) return null;
  const isAdmin = snapshot.membership.role === "admin";

  return (
    <SettingsSection
      id={searchableSetting("organization-machines").id}
      title={searchableSetting("organization-machines").title}
      icon={<ServerIcon className="size-4 text-muted-foreground" />}
    >
      <SectionNote>
        Machines are computers this organization buys through T3 Connect: agent executors run work,
        review hosts will run review apps. A provisioned machine sets itself up and then appears to
        every member beside their own environments. Destroying one also destroys any thread history
        it holds.
      </SectionNote>
      {machines.length === 0 ? (
        <Empty className="min-h-48">
          <EmptyMedia variant="icon">
            <ServerIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No machines yet</EmptyTitle>
            <EmptyDescription>
              Provision one and it joins this organization on its own — nobody signs in on it, and
              it can never be linked as somebody&apos;s personal environment.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        machines.map((machine) => (
          <MachineRow key={machine.machineId} machine={machine} state={state} nowMs={nowMs} />
        ))
      )}
      {isAdmin ? (
        <SettingsRow
          title="Provision a machine"
          description="Creates a fresh machine that sets itself up and calls home on its own — usually within a couple of minutes. Review hosts sit idle until review apps ship."
          control={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Input
                nativeInput
                value={label}
                placeholder="Name"
                aria-label="Machine name"
                onChange={(event) => setLabel(event.currentTarget.value)}
                className="w-full sm:w-48"
              />
              <Select
                value={role}
                onValueChange={(value) => {
                  if (typeof value === "string") setRole(value as RelayMachineRole);
                }}
              >
                <SelectTrigger className="w-40" aria-label="Machine role">
                  <SelectValue>{MACHINE_ROLE_LABELS[role]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="agent_executor">
                    Agent executor
                  </SelectItem>
                  <SelectItem hideIndicator value="review_host">
                    Review host
                  </SelectItem>
                </SelectPopup>
              </Select>
              <Button
                size="sm"
                disabled={state.busy || label.trim().length === 0}
                onClick={() => {
                  void state.provisionMachine({ label: label.trim(), role }).then((ok) => {
                    if (ok) setLabel("");
                  });
                }}
              >
                Provision
              </Button>
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function OrganizationSettingsNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("organization").id}
        title={searchableSetting("organization").title}
      >
        <Empty className="min-h-64">
          <EmptyMedia variant="icon">
            <BuildingIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{children}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/**
 * Split from `OrganizationSettings` because the state hook reads Clerk, and
 * `ClerkProvider` is only mounted when T3 Connect is configured. Calling the
 * hook above that check would crash the app on a build without it.
 */
function ConfiguredOrganizationSettings() {
  const state = useOrganizationAdmin();
  // The alert sits at the top of a long page while the action that failed may
  // be at the bottom. Bring the message to the person instead of hoping they
  // scroll up to look for one.
  const error = state.error;
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  if (!state.isSignedIn) {
    return (
      <OrganizationSettingsNotice title="Sign in to T3 Connect">
        Your organization is created the first time you ask for it, so signing in is all it takes.
      </OrganizationSettingsNotice>
    );
  }

  return (
    <SettingsPageContainer>
      {state.error ? (
        <p ref={errorRef} role="alert" className="px-3 text-sm text-destructive sm:px-4">
          {state.error}
        </p>
      ) : null}
      {state.loading && !state.snapshot ? (
        <div className="flex min-h-64 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          <OrganizationSection state={state} />
          <MembersSection state={state} />
          <GithubSection state={state} />
          <RepositoriesSection state={state} />
          <MachinesSection state={state} />
        </>
      )}
    </SettingsPageContainer>
  );
}

export function OrganizationSettings() {
  if (!hasCloudPublicConfig()) {
    return (
      <OrganizationSettingsNotice title="T3 Connect is not configured">
        Organizations live in the relay, so this build needs T3 Connect&apos;s keys and a relay URL
        before it can show one.
      </OrganizationSettingsNotice>
    );
  }
  return <ConfiguredOrganizationSettings />;
}
