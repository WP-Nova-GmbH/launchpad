import { createFileRoute } from "@tanstack/react-router";
import { WorkflowsPage } from "../components/workflows/WorkflowsPage";
export const Route = createFileRoute("/workflows/$repositoryId/jobs/$jobId")({
  component: () => <WorkflowsPage view="job" />,
});
