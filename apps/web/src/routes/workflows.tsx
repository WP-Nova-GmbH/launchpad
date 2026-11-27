import { createFileRoute, lazyRouteComponent, Outlet } from "@tanstack/react-router";

export const WorkflowEditorRouteComponent = lazyRouteComponent(
  () => import("../components/workflows/WorkflowsPage"),
  "WorkflowEditorPage",
);

export const Route = createFileRoute("/workflows")({ component: Outlet });
