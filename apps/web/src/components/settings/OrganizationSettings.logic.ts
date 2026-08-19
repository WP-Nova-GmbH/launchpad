import type { RepositoryIdentity } from "@t3tools/contracts";
import type { RelayRepositorySummary } from "@t3tools/contracts/relay";

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
