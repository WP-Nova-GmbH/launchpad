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
