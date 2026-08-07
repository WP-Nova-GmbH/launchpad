import { createFileRoute } from "@tanstack/react-router";

import { OrganizationSettings } from "../components/settings/OrganizationSettings";

export const Route = createFileRoute("/settings/organization")({
  component: OrganizationSettings,
});
