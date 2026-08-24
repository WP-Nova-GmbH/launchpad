export type StartRouteMode = "workspace" | "pending" | "onboarding";

export function resolveStartRouteMode(input: {
  readonly isHostedStatic: boolean;
  readonly environmentCount: number;
  readonly organizationRepositoryCount: number;
  readonly organizationProjectCount: number;
  readonly organizationCatalogPending: boolean;
  readonly organizationCatalogError: string | null;
}): StartRouteMode {
  const hasOrganizationWork =
    input.organizationRepositoryCount > 0 || input.organizationProjectCount > 0;
  if (!input.isHostedStatic || input.environmentCount > 0 || hasOrganizationWork) {
    return "workspace";
  }
  if (input.organizationCatalogPending) {
    return "pending";
  }
  return input.organizationCatalogError === null ? "onboarding" : "workspace";
}
