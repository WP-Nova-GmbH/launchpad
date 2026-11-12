import { createFileRoute } from "@tanstack/react-router";
import { WorkflowEditorRouteComponent } from "./workflows";
export const Route = createFileRoute("/workflows/$repositoryId/new")({
  codeSplitGroupings: [],
  component: WorkflowEditorRouteComponent,
});
