import type { RepositoryIdentity } from "@t3tools/contracts";
import type {
  RelayMachine,
  RelayProviderAccount,
  RelayProviderAccountProvider,
  RelayRepositorySummary,
} from "@t3tools/contracts/relay";

export interface ProviderAccountPresentation {
  readonly provider: RelayProviderAccountProvider;
  readonly name: string;
  /** Whether the app can lift this provider's sign-in off the admin's own device. */
  readonly shareable: boolean;
  /** The environment variables the provider CLI accepts a key or token through. */
  readonly keyNames: ReadonlyArray<string>;
}

/**
 * The providers an organization can share an account for, in the order the
 * page lists them. Cursor's agent keeps no session Launchpad can read, so it
 * takes a key only; the others take either.
 */
export const PROVIDER_ACCOUNT_PRESENTATIONS: ReadonlyArray<ProviderAccountPresentation> = [
  { provider: "codex", name: "Codex", shareable: true, keyNames: ["OPENAI_API_KEY"] },
  {
    provider: "claudeAgent",
    name: "Claude",
    shareable: true,
    keyNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  },
  { provider: "cursor", name: "Cursor", shareable: false, keyNames: ["CURSOR_API_KEY"] },
  {
    provider: "opencode",
    name: "OpenCode",
    shareable: true,
    keyNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
  },
];

/** One line saying what the organization holds for a provider, for the row under its name. */
export function providerAccountDescription(account: RelayProviderAccount | null): string {
  if (account === null) {
    return "Not shared. Executors have no account for this provider until an admin shares one.";
  }
  const what = account.kind === "env" ? "Key" : "Sign-in";
  return `${what} shared ${account.updatedAt.slice(0, 10)}: ${account.label}. Executors pick up changes within a few minutes.`;
}

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
              machine.computeKind === "self_hosted"
                ? "This machine never called home and no longer can. Destroy it and connect a fresh one."
                : "This machine never called home and no longer can. Destroy it and provision a fresh one.",
          }
        : {
            label: machine.computeKind === "self_hosted" ? "Waiting for setup" : "Setting up",
            dotClassName: "bg-warning",
            pingClassName: "bg-warning/60 duration-2000",
            guidance: null,
          };
  }
}

/**
 * The one command an admin runs on their own computer to turn it into this
 * machine. A dedicated home directory keeps the executor's state out of any
 * Launchpad the person already runs there — an environment somebody linked
 * can never enroll, so pointing at an existing install would only fail.
 */
export function machineEnrollmentCommand(enrollment: {
  readonly seed: string;
  readonly relayUrl: string;
}): string {
  return [
    'T3CODE_HOME="$HOME/.t3/machine"',
    `T3CODE_MACHINE_ENROLLMENT_SEED="${enrollment.seed}"`,
    `T3CODE_MACHINE_ENROLLMENT_RELAY_URL="${enrollment.relayUrl}"`,
    "npx t3 serve",
  ].join(" ");
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
