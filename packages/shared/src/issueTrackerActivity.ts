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

function toolService(name: unknown): RelayIssueTrackerService | undefined {
  if (typeof name !== "string") return undefined;
  const tool = name
    .trim()
    .replace(/\s+completed?$/i, "")
    .replace(
      /^(?:mcp__(?:t3-code|t3_code|t3code)__|(?:t3-code|t3_code|t3code)(?:[.:/_]|\s*·\s*))/i,
      "",
    );
  return [
    "read_linear_issue",
    "read_linear_comments",
    "read_linear_images",
    "view_linear_image",
  ].includes(tool)
    ? "linear"
    : tool === "read_jira_issue"
      ? "jira"
      : undefined;
}

/** Only Launchpad issue-tracker tools may supply the shared-account label. */
export function issueTrackerActivityService(
  entry: Pick<IssueTrackerActivity, "label" | "toolTitle" | "toolData">,
) {
  const data = Predicate.isObject(entry.toolData) ? entry.toolData : undefined;
  const item = Predicate.isObject(data?.item) ? data.item : data;
  if (typeof item?.server === "string" && typeof item.tool === "string") {
    return toolService(`${item.server}.${item.tool}`);
  }
  return (
    toolService(item?.toolName) ??
    toolService(item?.tool) ??
    toolService(entry.toolTitle) ??
    toolService(entry.label)
  );
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
