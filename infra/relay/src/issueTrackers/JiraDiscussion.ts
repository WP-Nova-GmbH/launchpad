import type { RelayJiraComment, RelayReadIssueResponse } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

import { IssueTrackerFailure } from "./IssueTrackerModels.ts";

export const JIRA_COMMENT_PAGE_SIZE = 10;
export const JIRA_COMMENT_BODY_BYTES = 4096;
export const JIRA_DISCUSSION_BYTES = 64 * 1024;
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

/** Preserve identity and discussion while fitting the complete serialized issue response. */
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

function clipBody(body: string, byteLimit: number) {
  const bytes = encoder.encode(body);
  return bytes.byteLength <= byteLimit ? body : decodePrefix(bytes.subarray(0, byteLimit));
}

/** Fit a normalized page without skipping records covered by its provider continuation. */
export const fitJiraDiscussion = Effect.fn("jiraDiscussion.fit")(function* (input: {
  readonly comments: ReadonlyArray<RelayJiraComment>;
  readonly continuation: string | null;
  readonly byteBudget?: number;
}) {
  const unavailable = () =>
    new IssueTrackerFailure({
      code: "unavailable",
      message:
        "The Jira discussion metadata could not fit the response budget. Open the issue in Jira.",
    });
  const budget = Math.min(input.byteBudget ?? JIRA_DISCUSSION_BYTES, JIRA_DISCUSSION_BYTES);
  if (
    !Number.isFinite(budget) ||
    budget < 0 ||
    input.comments.length > JIRA_COMMENT_PAGE_SIZE ||
    (input.continuation !== null &&
      (input.continuation.trim().length === 0 || input.continuation.length > 16_384))
  )
    return yield* unavailable();

  // Reserve the whole envelope before allocating body bytes. False is one byte
  // longer than true, so these flags also reserve space for later truncation.
  const comments = input.comments.map((comment) => ({
    ...comment,
    body: "",
    bodyTruncated: false,
  }));
  const page = {
    status: "available" as const,
    comments,
    continuation: input.continuation,
    hasMore: input.continuation !== null,
    contentTruncated: false,
  };
  let remaining = budget - jsonBytes(page);
  if (remaining < 0) return yield* unavailable();

  for (let index = 0; index < comments.length; index++) {
    const comment = comments[index]!;
    const original = input.comments[index]!;
    const allocation = Math.floor(remaining / (comments.length - index));
    const body = fitJsonText(clipBody(original.body, JIRA_COMMENT_BODY_BYTES), allocation);
    comment.body = body;
    comment.bodyTruncated = original.bodyTruncated || body !== original.body;
    remaining -= jsonBytes(body) - 2;
    page.contentTruncated ||= comment.bodyTruncated;
  }
  return page;
});
