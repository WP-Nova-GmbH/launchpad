import { createFileRoute } from "@tanstack/react-router";
import { WorkflowsPage } from "../components/workflows/WorkflowsPage";
export const Route = createFileRoute("/workflows/$repositoryId/")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === "runs" ? ("runs" as const) : ("workflows" as const),
  }),
  component: () => <WorkflowsPage view="catalog" />,
});
