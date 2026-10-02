import * as Predicate from "effect/Predicate";
import {
  issueTrackerActivityIdentity,
  issueTrackerActivityService,
  type IssueTrackerActivity,
} from "@t3tools/shared/issueTrackerActivity";
export { issueTrackerActivityService } from "@t3tools/shared/issueTrackerActivity";

export function issueTrackerActivityPresentation(
  entry: IssueTrackerActivity,
  fallbackStatus?: string,
) {
  const service = issueTrackerActivityService(entry);
  if (!service) return undefined;
  const data = Predicate.isObject(entry.toolData) ? entry.toolData : undefined;
  const item = Predicate.isObject(data?.item) ? data.item : data;
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  const identity = issueTrackerActivityIdentity(entry, fallbackStatus);
  const verb =
    status === "completed"
      ? "Read"
      : status === "failed"
        ? "Failed to read"
        : status === "declined"
          ? "Declined to read"
          : status === "stopped"
            ? "Stopped reading"
            : "Reading";
  const name = service === "linear" ? "Linear" : "Jira";
  const toolName = [item?.tool, item?.toolName, entry.toolTitle, entry.label]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const context = toolName.includes("view_linear_image")
    ? " image"
    : toolName.includes("read_linear_images")
      ? " image references"
      : toolName.includes("read_linear_comments") || toolName.includes("read_jira_comments")
        ? " discussion"
        : "";
  let url: string | undefined;
  if (identity?.url) {
    try {
      const candidate = new URL(identity.url);
      if (
        candidate.protocol === "https:" &&
        !candidate.username &&
        !candidate.password &&
        (service !== "linear" || candidate.hostname === "linear.app")
      )
        url = candidate.href;
    } catch {
      /* Malformed source URLs do not become links. */
    }
  }
  return {
    displayName: identity
      ? `${verb} ${name} issue ${identity.identifier}${context} · ${identity.accountLabel}`
      : `${verb} a ${name} issue${context}`,
    icon: "t3-code" as const,
    action: undefined,
    ...(url ? { issueUrl: url } : {}),
  };
}

export function issueTrackerActivityLabel(entry: IssueTrackerActivity, fallbackStatus?: string) {
  return issueTrackerActivityPresentation(entry, fallbackStatus)?.displayName;
}
