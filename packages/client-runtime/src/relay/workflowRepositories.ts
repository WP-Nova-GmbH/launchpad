import type { RelayRepository } from "@t3tools/contracts/relay";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

export function matchesWorkflowRepository(
  repository: Pick<RelayRepository, "name" | "canonicalKeys">,
  query: string,
): boolean {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return true;
  const fields = [repository.name, ...repository.canonicalKeys].map((value) => value.toLowerCase());
  return normalized.split(/\s+/u).every((term) => fields.some((field) => field.includes(term)));
}

export function workflowRepositoryRemote(
  repository: Pick<RelayRepository, "name" | "canonicalKeys">,
  query: string,
): string | undefined {
  return (
    repository.canonicalKeys.find((canonicalKey) =>
      matchesWorkflowRepository({ name: repository.name, canonicalKeys: [canonicalKey] }, query),
    ) ?? repository.canonicalKeys[0]
  );
}
