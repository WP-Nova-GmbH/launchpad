import type { RelayReadIssueResponse } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

import { IssueTrackerFailure } from "./IssueTrackerModels.ts";

export const JIRA_ISSUE_RESPONSE_BYTES = 128 * 1024;

const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
export const JIRA_DESCRIPTION_TRUNCATION_NOTICE =
  "\n\n[Description truncated by Launchpad. Open the issue for the full text.]";

// Streaming decoding omits an incomplete trailing code point; keep a leading BOM.
const decodePrefix = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes, { stream: true });

function fitJsonText(body: string, byteBudget: number) {
  if (jsonBytes(body) - 2 <= byteBudget) return body;
  const bytes = encoder.encode(body);
  let lower = 0;
  let upper = bytes.byteLength;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (jsonBytes(decodePrefix(bytes.subarray(0, middle))) - 2 <= byteBudget) lower = middle;
    else upper = middle - 1;
  }
  return decodePrefix(bytes.subarray(0, lower));
}

/** Preserve issue metadata while fitting the complete serialized issue response. */
export const fitJiraIssueResponse = Effect.fn("jiraDiscussion.fit_issue")(function* <
  A extends RelayReadIssueResponse,
>(response: A) {
  if (jsonBytes(response) <= JIRA_ISSUE_RESPONSE_BYTES) return response;
  const envelope = { ...response, description: JIRA_DESCRIPTION_TRUNCATION_NOTICE };
  const remaining = JIRA_ISSUE_RESPONSE_BYTES - jsonBytes(envelope);
  if (remaining < 0)
    return yield* new IssueTrackerFailure({
      code: "unavailable",
      message: "The Jira issue metadata could not fit the response budget. Open the issue in Jira.",
    });
  const body = response.description.endsWith(JIRA_DESCRIPTION_TRUNCATION_NOTICE)
    ? response.description.slice(0, -JIRA_DESCRIPTION_TRUNCATION_NOTICE.length)
    : response.description;
  return {
    ...response,
    description: fitJsonText(body, remaining) + JIRA_DESCRIPTION_TRUNCATION_NOTICE,
  };
});
