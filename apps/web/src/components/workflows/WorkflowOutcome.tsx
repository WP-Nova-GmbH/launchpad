import type { ReactNode } from "react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  FileDiffIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";

export function WorkflowOutcome({
  title,
  children,
  actions,
  footer,
  tone = "neutral",
  icon,
  announce = true,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  tone?: "error" | "warning" | "neutral" | "success";
  icon?: LucideIcon | undefined;
  announce?: boolean;
}) {
  const success = tone === "success";
  const warning = tone === "warning";
  const error = tone === "error";
  const Icon =
    icon ??
    (error
      ? CircleAlertIcon
      : warning
        ? TriangleAlertIcon
        : success
          ? CircleCheckIcon
          : FileDiffIcon);
  return (
    <div
      className={cn(
        "flex flex-wrap justify-between gap-3 rounded-lg border p-4 text-card-foreground",
        error && "border-error/32 bg-error-surface",
        warning && "border-warning/32 bg-warning-surface",
        tone === "neutral" && "bg-card",
        success ? "items-center bg-card" : "items-start",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 basis-56 gap-2",
          success ? "items-center" : "items-start",
        )}
      >
        <span
          className={cn(
            "shrink-0",
            error && "text-error",
            warning && "text-warning",
            tone === "neutral" && "text-muted-foreground",
            success
              ? "grid size-8 place-items-center rounded-md bg-success/10 text-success-foreground"
              : "mt-0.5",
          )}
        >
          <Icon aria-hidden className="block size-4" />
        </span>
        <div
          className="min-w-0 space-y-1"
          role={announce ? (error || warning ? "alert" : "status") : undefined}
        >
          <h2 className="text-sm font-semibold">{title}</h2>
          {children ? (
            <div
              className={cn(
                "space-y-1 text-sm",
                error || warning ? "text-card-foreground/80" : "text-muted-foreground",
              )}
            >
              {children}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      {footer ? <div className="w-full border-t border-current/15 pt-3">{footer}</div> : null}
    </div>
  );
}
