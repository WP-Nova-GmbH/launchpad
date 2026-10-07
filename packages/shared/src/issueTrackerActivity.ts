import type { RelayIssueTrackerService } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const IssueIdentity = Schema.Struct({
  service: Schema.Literals(["linear", "jira"]),
  accountLabel: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  identifier: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
const decodeIdentity = Schema.decodeUnknownOption(IssueIdentity);

export interface IssueTrackerActivity {
  readonly label: string;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly toolLifecycleStatus?: string;
}

const issueTrackerToolTitles = {
  read_linear_issue: "Read Linear Issue",
  read_jira_issue: "Read Jira Issue",
  search_linear_issues: "Search Linear Issues",
  search_jira_issues: "Search Jira Issues",
  read_linear_comments: "Read Linear Discussion",
  read_jira_comments: "Read Jira Discussion",
  read_linear_images: "Read Linear Image References",
  view_linear_image: "View Linear Image",
  add_linear_comment: "Add Linear Comment",
  add_jira_comment: "Add Jira Comment",
  edit_linear_issue: "Edit Linear Issue",
  edit_jira_issue: "Edit Jira Issue",
} as const;

export type IssueTrackerToolName = keyof typeof issueTrackerToolTitles;

const isLaunchpadServer = (value: string) => /^t3[-_ ]?code$/i.test(value);

function toolName(value: unknown): IssueTrackerToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .replace(/\s+completed?$/i, "")
    .replace(/^mcp__t3[-_ ]?code__/i, "")
    .replace(/^t3[-_ ]?code(?:[.:/_]|\s*[·°]\s*)/i, "");
  return Object.hasOwn(issueTrackerToolTitles, normalized)
    ? (normalized as IssueTrackerToolName)
    : undefined;
}

/** Resolve only known Launchpad tools; an explicit foreign server wins over a matching name. */
export function issueTrackerActivityToolName(
  entry: Pick<IssueTrackerActivity, "label" | "toolTitle" | "toolData">,
): IssueTrackerToolName | undefined {
  const data = Predicate.isObject(entry.toolData) ? entry.toolData : undefined;
  const item = Predicate.isObject(data?.item) ? data.item : data;
  if (typeof item?.server === "string") {
    return isLaunchpadServer(item.server)
      ? (toolName(item.tool) ?? toolName(item.toolName))
      : undefined;
  }
  return (
    toolName(item?.toolName) ??
    toolName(item?.tool) ??
    toolName(entry.toolTitle) ??
    toolName(entry.label)
  );
}

export function issueTrackerToolTitle(name: IssueTrackerToolName): string {
  return issueTrackerToolTitles[name];
}

function toolService(name: unknown): RelayIssueTrackerService | undefined {
  if (typeof name !== "string") return undefined;
  return [
    "read_linear_issue",
    "read_linear_comments",
    "read_linear_images",
    "view_linear_image",
  ].includes(name)
    ? "linear"
    : ["read_jira_issue", "read_jira_comments"].includes(name)
      ? "jira"
      : undefined;
}

/** Only Launchpad issue-tracker reads may supply the connected-account label. */
export function issueTrackerActivityService(
  entry: Pick<IssueTrackerActivity, "label" | "toolTitle" | "toolData">,
) {
  return toolService(issueTrackerActivityToolName(entry));
}

function decodeResult(value: unknown) {
  let decoded = value;
  if (typeof value === "string") {
    // Only parse a bounded tool result; issue descriptions are never searched for identity.
    if (value.length > 262_144 || !value.trimStart().startsWith("{")) return undefined;
    try {
      decoded = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return Option.getOrUndefined(decodeIdentity(decoded));
}

function resultIdentity(value: unknown) {
  const direct = decodeResult(value);
  if (direct) return direct;
  const record = Predicate.isObject(value) ? value : undefined;
  if (record?.isError === true || record?.is_error === true) return undefined;
  const structured = decodeResult(record?.structuredContent);
  if (structured) return structured;
  const content = record?.content ?? (Array.isArray(value) ? value : undefined);
  const text = decodeResult(content);
  if (text) return text;
  if (!Array.isArray(content)) return undefined;
  for (const block of content.slice(0, 20)) {
    if (!Predicate.isObject(block)) continue;
    const textBlock =
      block.type === "content" && Predicate.isObject(block.content) ? block.content : block;
    if (textBlock.type !== "text") continue;
    const identity = decodeResult(textBlock.text);
    if (identity) return identity;
  }
  return undefined;
}

/** Extract only the bounded identity that survives activity payload projection. */
export function issueTrackerActivityIdentity(entry: IssueTrackerActivity, fallbackStatus?: string) {
  const service = issueTrackerActivityService(entry);
  if (!service || (entry.toolLifecycleStatus ?? fallbackStatus) !== "completed") return undefined;
  const data = Predicate.isObject(entry.toolData) ? entry.toolData : undefined;
  const item = Predicate.isObject(data?.item) ? data.item : data;
  const state = Predicate.isObject(item?.state) ? item.state : undefined;
  if (item?.error != null || state?.status === "error") return undefined;
  return [data?.issueTrackerIdentity, item?.result, state?.output, item?.rawOutput, item?.content]
    .map(resultIdentity)
    .find((result) => result?.service === service);
}
