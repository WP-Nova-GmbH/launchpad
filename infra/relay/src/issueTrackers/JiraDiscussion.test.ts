import { describe, expect, it } from "@effect/vitest";
import { RelayJiraDiscussion } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  fitJiraDiscussion,
  fitJiraIssueResponse,
  JIRA_DESCRIPTION_TRUNCATION_NOTICE,
  JIRA_ISSUE_RESPONSE_BYTES,
  JIRA_COMMENT_BODY_BYTES,
  JIRA_DISCUSSION_BYTES,
} from "./JiraDiscussion.ts";

// These are Launchpad's normalized records, not fixtures for Atlassian's unverified tool schema.
const comment = (id: string, body = "A comment") => ({
  id,
  body,
  author: "Alice" as string | null,
  createdAt: "2026-10-01T10:00:00Z",
  editedAt: null as string | null,
  url: `https://team.atlassian.net/browse/ENG-1?focusedCommentId=${id}`,
  bodyTruncated: false,
});
const isDiscussion = Schema.is(RelayJiraDiscussion);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("Jira normalized discussion budgeting", () => {
  it.effect("preserves an ordinary page, its identity, edits and source links", () =>
    Effect.gen(function* () {
      const comments = [
        { ...comment("2", "Updated **context**"), editedAt: "2026-10-01T10:01:00Z" },
        { ...comment("1"), author: null },
      ];
      const result = yield* fitJiraDiscussion({ comments, continuation: "next-reference" });
      expect(result).toEqual({
        status: "available",
        comments,
        continuation: "next-reference",
        hasMore: true,
        contentTruncated: false,
      });
      expect(isDiscussion(result)).toBe(true);
    }),
  );

  it.effect("returns an available empty discussion at the end", () =>
    Effect.gen(function* () {
      expect(yield* fitJiraDiscussion({ comments: [], continuation: null })).toEqual({
        status: "available",
        comments: [],
        continuation: null,
        hasMore: false,
        contentTruncated: false,
      });
    }),
  );

  it.effect(
    "keeps all IDs and a whole-page continuation when JSON escaping exceeds the budget",
    () =>
      Effect.gen(function* () {
        const comments = Array.from({ length: 10 }, (_, index) =>
          comment(String(index), "\\".repeat(JIRA_COMMENT_BODY_BYTES)),
        );
        const continuation = "sealed-page-reference".repeat(700);
        expect(bytes(comments)).toBeGreaterThan(JIRA_DISCUSSION_BYTES);
        const result = yield* fitJiraDiscussion({ comments, continuation });
        expect(result.comments.map(({ id }) => id)).toEqual(comments.map(({ id }) => id));
        expect(
          result.comments.every(({ body, bodyTruncated }) => body.length > 0 && bodyTruncated),
        ).toBe(true);
        expect(result.continuation).toBe(continuation);
        expect(result.hasMore).toBe(true);
        expect(result.contentTruncated).toBe(true);
        expect(bytes(result)).toBeLessThanOrEqual(JIRA_DISCUSSION_BYTES);
        expect(comments[0]?.body).toHaveLength(JIRA_COMMENT_BODY_BYTES);
        expect(comments[0]?.bodyTruncated).toBe(false);
      }),
  );

  it.effect("leaves enough room for later bodies when one early body is large", () =>
    Effect.gen(function* () {
      const comments = [comment("1", "x".repeat(20_000)), comment("2", "Important context")];
      const result = yield* fitJiraDiscussion({ comments, continuation: null, byteBudget: 1024 });
      expect(result.comments[0]?.bodyTruncated).toBe(true);
      expect(result.comments[1]).toEqual(comments[1]);
      expect(bytes(result)).toBeLessThanOrEqual(1024);
    }),
  );

  it.effect.each(["🙂", "é", "漢", "\n", '"', "\\", "\ufeff"])(
    "keeps valid prefixes of %j at multiple response budgets",
    (character) =>
      Effect.gen(function* () {
        const body = character.repeat(6000);
        for (const byteBudget of [512, 1024, 4096, JIRA_DISCUSSION_BYTES]) {
          const result = yield* fitJiraDiscussion({
            comments: [comment("1", body)],
            continuation: null,
            byteBudget,
          });
          const output = result.comments[0]!;
          expect(body.startsWith(output.body)).toBe(true);
          expect(output.body).not.toContain("�");
          expect(output.bodyTruncated).toBe(true);
          expect(result.contentTruncated).toBe(true);
          expect(new TextEncoder().encode(output.body).byteLength).toBeLessThanOrEqual(
            JIRA_COMMENT_BODY_BYTES,
          );
          expect(bytes(result)).toBeLessThanOrEqual(byteBudget);
        }
      }),
  );

  it.effect("retains an earlier truncation marker even when no additional clipping is needed", () =>
    Effect.gen(function* () {
      const comments = [{ ...comment("1", "Already shortened"), bodyTruncated: true }];
      const result = yield* fitJiraDiscussion({ comments, continuation: null });
      expect(result.comments).toEqual(comments);
      expect(result.contentTruncated).toBe(true);
    }),
  );

  it.effect("reserves large metadata and both JSON flags before adding any bodies", () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 10 }, (_, index) => ({
        ...comment(String(index), "\\".repeat(4096)),
        author: "漢".repeat(256),
        url: `https://team.atlassian.net/browse/${"A".repeat(1900)}-${index + 1}`,
      }));
      const result = yield* fitJiraDiscussion({ comments, continuation: "x".repeat(16_384) });
      expect(result.comments.map(({ id }) => id)).toEqual(comments.map(({ id }) => id));
      expect(result.comments.every(({ bodyTruncated }) => bodyTruncated)).toBe(true);
      expect(bytes(result)).toBeLessThanOrEqual(JIRA_DISCUSSION_BYTES);
    }),
  );

  it.effect("fails explicitly when an initial issue leaves no room for the metadata", () =>
    Effect.gen(function* () {
      const failure = yield* fitJiraDiscussion({
        comments: [comment("1")],
        continuation: "next-reference",
        byteBudget: 1,
      }).pipe(Effect.flip);
      expect(failure.code).toBe("unavailable");
      expect(failure.message).toContain("metadata");
    }),
  );

  it.effect("rejects an oversized record count instead of advancing past omitted records", () =>
    Effect.gen(function* () {
      const failure = yield* fitJiraDiscussion({
        comments: Array.from({ length: 11 }, (_, index) => comment(String(index))),
        continuation: "next-reference",
      }).pipe(Effect.flip);
      expect(failure.code).toBe("unavailable");
    }),
  );

  it.effect.each(["", " ", "x".repeat(16_385)])("rejects an invalid continuation", (continuation) =>
    Effect.gen(function* () {
      expect(
        (yield* fitJiraDiscussion({ comments: [comment("1")], continuation }).pipe(Effect.flip))
          .code,
      ).toBe("unavailable");
    }),
  );
});

const issueResponse = (description: string) => ({
  service: "jira" as const,
  accountLabel: "team.atlassian.net",
  identifier: "ENG-1",
  title: "An issue",
  description,
  url: "https://team.atlassian.net/browse/ENG-1",
  status: "Open",
  assignee: null,
});

describe("Jira complete issue response budgeting", () => {
  it.effect("preserves an ordinary response without shortening its description", () =>
    Effect.gen(function* () {
      const response = issueResponse("Read **this** issue.");
      expect(yield* fitJiraIssueResponse(response)).toEqual(response);
    }),
  );

  it.effect.each(["available", "unavailable"] as const)(
    "reserves identity and %s discussion before fitting an escape-heavy description",
    (status) =>
      Effect.gen(function* () {
        const description = "\u0001".repeat(20_000);
        const discussion =
          status === "available"
            ? yield* fitJiraDiscussion({
                comments: Array.from({ length: 10 }, (_, i) =>
                  comment(String(i), "\\".repeat(4096)),
                ),
                continuation: "continuation-reference",
              })
            : { status: "unavailable" as const, reason: "Use the source reference to retry." };
        const response = {
          ...issueResponse(description),
          title: "\u0001".repeat(4096),
          status: "\u0001".repeat(512),
          assignee: "\u0001".repeat(512),
          jira: { source: "issue-source", cloudId: "site", issueId: "123", discussion },
        };
        expect(bytes(response)).toBeGreaterThan(JIRA_ISSUE_RESPONSE_BYTES);
        const result = yield* fitJiraIssueResponse(response);
        expect(bytes(result)).toBeLessThanOrEqual(JIRA_ISSUE_RESPONSE_BYTES);
        expect(result.description.endsWith(JIRA_DESCRIPTION_TRUNCATION_NOTICE)).toBe(true);
        expect(result.description.length).toBeLessThan(description.length);
        expect({ ...result, description }).toEqual(response);
        expect(response.description).toBe(description);
      }),
  );

  it.effect("clips Unicode at code-point boundaries and keeps a leading BOM", () =>
    Effect.gen(function* () {
      const description = "\ufeff" + "🙂é漢".repeat(30_000);
      const result = yield* fitJiraIssueResponse(issueResponse(description));
      const prefix = result.description.slice(0, -JIRA_DESCRIPTION_TRUNCATION_NOTICE.length);
      expect(prefix.startsWith("\ufeff")).toBe(true);
      expect(description.startsWith(prefix)).toBe(true);
      expect(prefix).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(bytes(result)).toBeLessThanOrEqual(JIRA_ISSUE_RESPONSE_BYTES);
    }),
  );

  it.effect(
    "retains exactly one truncation notice when shortening an already clipped description",
    () =>
      Effect.gen(function* () {
        const result = yield* fitJiraIssueResponse(
          issueResponse("\u0001".repeat(30_000) + JIRA_DESCRIPTION_TRUNCATION_NOTICE),
        );
        expect(result.description.split(JIRA_DESCRIPTION_TRUNCATION_NOTICE)).toHaveLength(2);
        expect(bytes(result)).toBeLessThanOrEqual(JIRA_ISSUE_RESPONSE_BYTES);
      }),
  );

  it.effect("fails explicitly when required metadata cannot fit even without a description", () =>
    Effect.gen(function* () {
      const failure = yield* fitJiraIssueResponse({
        ...issueResponse(""),
        title: "x".repeat(JIRA_ISSUE_RESPONSE_BYTES),
      }).pipe(Effect.flip);
      expect(failure.code).toBe("unavailable");
      expect(failure.message).toContain("metadata");
    }),
  );
});
