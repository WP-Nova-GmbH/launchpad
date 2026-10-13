import { createFileRoute } from "@tanstack/react-router";
import { WorkflowsPage } from "../components/workflows/WorkflowsPage";
export const Route = createFileRoute("/workflows/$repositoryId/new")({
  component: () => <WorkflowsPage view="builder" />,
});
