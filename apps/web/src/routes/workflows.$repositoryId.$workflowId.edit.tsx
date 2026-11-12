import { createFileRoute } from "@tanstack/react-router";
import { WorkflowEditorRouteComponent } from "./workflows";
export const Route = createFileRoute("/workflows/$repositoryId/$workflowId/edit")({
  validateSearch: (search: Record<string, unknown>): { settings?: "execution" } =>
    search.settings === "execution" ? { settings: "execution" } : {},
  codeSplitGroupings: [],
  component: WorkflowEditorRouteComponent,
});
