import { createFileRoute } from "@tanstack/react-router";
import { WorkflowsPage } from "../components/workflows/WorkflowsPage";
export const Route = createFileRoute("/workflows/$repositoryId/$workflowId/edit")({
  validateSearch: (search: Record<string, unknown>): { settings?: "execution" } =>
    search.settings === "execution" ? { settings: "execution" } : {},
  component: () => <WorkflowsPage view="builder" />,
});
