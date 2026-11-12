import type { ReactNode } from "react";
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

/** Workflow recovery actions wrap below the explanation, including in narrow inspectors. */
export function WorkflowAlert({
  title,
  children,
  actions,
  variant = "error",
  announce = true,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  variant?: "error" | "warning" | "info";
  announce?: boolean;
}) {
  const Icon =
    variant === "warning" ? TriangleAlertIcon : variant === "info" ? InfoIcon : CircleAlertIcon;
  return (
    <div className="min-w-0 wrap-anywhere">
      <Alert
        variant={variant}
        controlAlignment="first-line"
        role={announce ? (variant === "info" ? "status" : "alert") : undefined}
      >
        <Icon />
        <AlertTitle role="heading" aria-level={2}>
          {title}
        </AlertTitle>
        <AlertDescription>
          <div>{children}</div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}
