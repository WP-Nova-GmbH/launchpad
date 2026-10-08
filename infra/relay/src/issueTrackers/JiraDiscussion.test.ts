import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  fitJiraIssueResponse,
  JIRA_DESCRIPTION_TRUNCATION_NOTICE,
  JIRA_ISSUE_RESPONSE_BYTES,
} from "./JiraDiscussion.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

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

  it.effect("preserves metadata while fitting an escape-heavy description", () =>
    Effect.gen(function* () {
      const description = "\u0001".repeat(20_000);
      const response = {
        ...issueResponse(description),
        title: "\u0001".repeat(4096),
        status: "\u0001".repeat(512),
        assignee: "\u0001".repeat(512),
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
