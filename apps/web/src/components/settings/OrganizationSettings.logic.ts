import type { RepositoryIdentity } from "@t3tools/contracts";
import type { RelayMachine, RelayRepositorySummary } from "@t3tools/contracts/relay";

export interface UnregisteredCheckout {
  readonly canonicalKey: string;
  readonly suggestedName: string;
}

export interface CheckoutLike {
  readonly title: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/**
 * Checkouts whose canonical key no repository owns yet.
 *
 * Only meaningful for an administrator: a member sees just the repositories
 * they hold a role on, so for them "absent from the list" would not mean
 * "unregistered" (ADR-0006). Deduplicated by key, because several checkouts of
 * one repository are one registration.
 */
export function unregisteredCheckouts(
  projects: ReadonlyArray<CheckoutLike>,
  repositories: ReadonlyArray<RelayRepositorySummary>,
): ReadonlyArray<UnregisteredCheckout> {
  const registered = new Set(
    repositories.flatMap((entry) => entry.repository.canonicalKeys as ReadonlyArray<string>),
  );
  const byKey = new Map<string, string>();
  for (const project of projects) {
    const identity = project.repositoryIdentity;
    if (!identity || registered.has(identity.canonicalKey) || byKey.has(identity.canonicalKey)) {
      continue;
    }
    byKey.set(identity.canonicalKey, identity.name ?? project.title);
  }
  return [...byKey].map(([canonicalKey, suggestedName]) => ({ canonicalKey, suggestedName }));
}

export interface MachineStatusPresentation {
  readonly label: string;
  /** Dot color, in the same vocabulary `ConnectionStatusDot` uses everywhere else. */
  readonly dotClassName: string;
  /** Ping halo for the one transitional state; null renders no ping. */
  readonly pingClassName: string | null;
  /** What to do about it, when the status is a dead end rather than a phase. */
  readonly guidance: string | null;
}

/**
 * What a machine's status means to a person looking at the list. The relay
 * derives the coarse status; the one nuance added here is that a machine
 * still waiting past its seed's expiry can never enroll and needs to be
 * destroyed and recreated — which is why that state gets guidance and the
 * failure color, not another neutral label.
 */
export function machineStatusPresentation(
  machine: RelayMachine,
  nowMs: number,
): MachineStatusPresentation {
  switch (machine.status) {
    case "deprovisioned":
      return {
        label: "Destroyed",
        dotClassName: "bg-muted-foreground/40",
        pingClassName: null,
        guidance: null,
      };
    case "ready":
      return { label: "Ready", dotClassName: "bg-success", pingClassName: null, guidance: null };
    case "awaiting_enrollment":
      return Date.parse(machine.seedExpiresAt) <= nowMs
        ? {
            label: "Enrollment expired",
            dotClassName: "bg-destructive",
            pingClassName: null,
            guidance:
              "This machine never called home and no longer can. Destroy it and provision a fresh one.",
          }
        : {
            label: "Setting up",
            dotClassName: "bg-warning",
            pingClassName: "bg-warning/60 duration-2000",
            guidance: null,
          };
  }
}

/**
 * The machines worth a row. A destroyed machine is gone — its record survives
 * in the relay, but a settings list that only ever grows would bury the
 * machines that exist under the ones that no longer do.
 */
export function visibleMachines(
  machines: ReadonlyArray<RelayMachine>,
): ReadonlyArray<RelayMachine> {
  return machines.filter((machine) => machine.status !== "deprovisioned");
}

/**
 * Whether any machine may still flip to ready on its own — the condition for
 * the list refreshing itself instead of asking the admin to reload.
 */
export function hasMachineSettingUp(machines: ReadonlyArray<RelayMachine>, nowMs: number): boolean {
  return machines.some(
    (machine) =>
      machine.status === "awaiting_enrollment" && Date.parse(machine.seedExpiresAt) > nowMs,
  );
}

export interface IdentifiedUser {
  readonly userId: string;
  readonly identity: {
    readonly displayName: string | null;
    readonly email: string | null;
  } | null;
}

/**
 * What to call somebody in a roster.
 *
 * The relay keys membership by subject id and resolves names from the identity
 * provider on read, so the name can be missing — a fresh account with no
 * profile, or a directory that did not answer. Falling back through email to
 * the subject id keeps every row identifiable instead of blank.
 */
export function memberLabel(user: IdentifiedUser): {
  readonly primary: string;
  readonly secondary: string | null;
} {
  const name = user.identity?.displayName?.trim();
  const email = user.identity?.email?.trim();
  if (name && email) return { primary: name, secondary: email };
  if (name) return { primary: name, secondary: null };
  if (email) return { primary: email, secondary: null };
  return { primary: user.userId, secondary: null };
}
