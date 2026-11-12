import type { ReactNode } from "react";
import { CircleAlertIcon, FileDiffIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "../../lib/utils";

export function WorkflowOutcome({
  title,
  children,
  actions,
  tone = "neutral",
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  tone?: "error" | "warning" | "neutral";
}) {
  const Icon =
    tone === "error" ? CircleAlertIcon : tone === "warning" ? TriangleAlertIcon : FileDiffIcon;
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4 text-card-foreground",
        tone === "error" && "border-error/32 bg-error-surface",
        tone === "warning" && "border-warning/32 bg-warning-surface",
        tone === "neutral" && "bg-card",
      )}
    >
      <div className="flex min-w-0 flex-1 basis-56 items-start gap-2">
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0",
            tone === "error" && "text-error",
            tone === "warning" && "text-warning",
            tone === "neutral" && "text-muted-foreground",
          )}
        />
        <div className="min-w-0 space-y-1" role={tone === "neutral" ? "status" : "alert"}>
          <h2 className="text-sm font-semibold">{title}</h2>
          <div
            className={cn(
              "space-y-1 text-sm",
              tone === "neutral" ? "text-muted-foreground" : "text-card-foreground/80",
            )}
          >
            {children}
          </div>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
