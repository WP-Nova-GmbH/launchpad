import {
  ORGANIZATION_SKILL_FILE_MAX_LENGTH,
  ORGANIZATION_SKILL_MANIFEST_FILE,
  ORGANIZATION_SKILL_MAX_FILES,
  ORGANIZATION_SKILL_MAX_TOTAL_LENGTH,
  ORGANIZATION_SKILL_NAME_MAX_LENGTH,
  OrganizationSkillFilePath,
  OrganizationSkillName,
  type OrganizationSkillFile,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import type {
  RelayMachine,
  RelayOrganizationSkill,
  RelayProviderAccount,
  RelayProviderAccountProvider,
  RelayRepositorySummary,
} from "@t3tools/contracts/relay";
import { parseSkillFrontmatter } from "@t3tools/shared/skillFrontmatter";
import * as Schema from "effect/Schema";

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

/** One line saying what a skill is and when it last changed, for the row under its name. */
export function organizationSkillDescription(skill: RelayOrganizationSkill): string {
  const what = skill.description || `No description in ${ORGANIZATION_SKILL_MANIFEST_FILE}.`;
  return `${what} Updated ${skill.updatedAt.slice(0, 10)}.`;
}

/** A file as the browser hands it over: its path within the chosen folder, and its text. */
export interface SkillUploadEntry {
  /** As reported by the file picker; a folder pick prefixes every path with the folder's name. */
  readonly relativePath: string;
  readonly content: string;
}

export type SkillUpload =
  | {
      readonly ok: true;
      readonly name: OrganizationSkillName;
      readonly files: ReadonlyArray<OrganizationSkillFile>;
    }
  | { readonly ok: false; readonly reason: string };

const isSkillName = Schema.is(OrganizationSkillName);
const isSkillFilePath = Schema.is(OrganizationSkillFilePath);

// Finder and Explorer leave these behind; nobody means to upload them.
const JUNK_ENTRY_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const JUNK_DIRECTORIES = new Set(["__MACOSX", ".git"]);

function looksBinary(content: string): boolean {
  return content.includes("\u0000") || content.includes("\uFFFD");
}

/**
 * Turn what the file picker returned into one skill the relay accepts, or
 * say why it cannot. A picked folder arrives with its own name on every
 * path, so that first segment is stripped and doubles as the skill's name
 * when the manifest's frontmatter carries none.
 */
export function buildSkillUpload(entries: ReadonlyArray<SkillUploadEntry>): SkillUpload {
  const split = entries
    .map((entry) => ({
      segments: entry.relativePath.replaceAll("\\", "/").split("/").filter(Boolean),
      content: entry.content,
    }))
    .filter(
      (entry) =>
        entry.segments.length > 0 &&
        !JUNK_ENTRY_NAMES.has(entry.segments.at(-1) ?? "") &&
        !entry.segments.some((segment) => JUNK_DIRECTORIES.has(segment)),
    );
  if (split.length === 0) {
    return { ok: false, reason: "Nothing to upload: the selection holds no files." };
  }

  // Everything came from one picked folder when every path starts with the
  // same segment and at least one path goes deeper than it.
  const firstSegment = split[0]?.segments[0] ?? "";
  const fromFolder =
    split.every((entry) => entry.segments[0] === firstSegment) &&
    split.some((entry) => entry.segments.length > 1);
  const folderName = fromFolder ? firstSegment : null;
  const files = split.map((entry) => ({
    path: (fromFolder ? entry.segments.slice(1) : entry.segments).join("/"),
    content: entry.content,
  }));

  const manifest = files.find((file) => file.path === ORGANIZATION_SKILL_MANIFEST_FILE);
  if (!manifest) {
    return {
      ok: false,
      reason: `A skill needs a ${ORGANIZATION_SKILL_MANIFEST_FILE} at the top of its folder.`,
    };
  }
  const frontmatter = parseSkillFrontmatter(manifest.content);
  if (frontmatter.kind === "malformed") {
    return {
      ok: false,
      reason: `The frontmatter in ${ORGANIZATION_SKILL_MANIFEST_FILE} could not be read. It should be a YAML block with a name and a description.`,
    };
  }
  const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? folderName;
  if (name === null || name === undefined) {
    return {
      ok: false,
      reason: `Name the skill: add a name to the ${ORGANIZATION_SKILL_MANIFEST_FILE} frontmatter, or upload a folder named after it.`,
    };
  }
  if (!isSkillName(name)) {
    return {
      ok: false,
      reason: `'${name}' is not a skill name the agents accept: use lowercase letters, digits, and single hyphens, at most ${ORGANIZATION_SKILL_NAME_MAX_LENGTH} characters.`,
    };
  }

  if (files.length > ORGANIZATION_SKILL_MAX_FILES) {
    return {
      ok: false,
      reason: `A skill can hold at most ${ORGANIZATION_SKILL_MAX_FILES} files; this one has ${files.length}.`,
    };
  }
  let total = 0;
  for (const file of files) {
    if (!isSkillFilePath(file.path)) {
      return {
        ok: false,
        reason: `'${file.path}' cannot be part of a skill: paths may only use letters, digits, dots, hyphens, and underscores.`,
      };
    }
    if (looksBinary(file.content)) {
      return { ok: false, reason: `'${file.path}' is not a text file. Skills carry text only.` };
    }
    if (file.content.length > ORGANIZATION_SKILL_FILE_MAX_LENGTH) {
      return {
        ok: false,
        reason: `'${file.path}' is too large: each file may hold at most ${Math.floor(ORGANIZATION_SKILL_FILE_MAX_LENGTH / 1024)} KiB.`,
      };
    }
    total += file.content.length;
  }
  if (total > ORGANIZATION_SKILL_MAX_TOTAL_LENGTH) {
    return {
      ok: false,
      reason: `The skill is too large: all files together may hold at most ${Math.floor(ORGANIZATION_SKILL_MAX_TOTAL_LENGTH / 1024)} KiB.`,
    };
  }
  return { ok: true, name, files };
}
