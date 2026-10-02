import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { getLinearIdentity, readLinearIssue } from "./Linear.ts";
import { issue, mcpFixture, workspace } from "./LinearMcp.test-fixture.ts";
import { encodeJson } from "./Connections.test-fixture.ts";
import { normalizeLinearMarkdown } from "./LinearMarkdown.ts";
const input = {
  accessToken: "private-access",
  workspaceId: "workspace",
  workspaceSlug: "launchpad",
  issue: "LP-42",
};

describe("Linear MCP readers", () => {
  it.effect("identifies the immutable workspace and authorizing account", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture();
      expect(yield* getLinearIdentity(input).pipe(test.provide)).toEqual({
        workspaceId: "workspace",
        workspaceName: "Launchpad",
        workspaceSlug: "launchpad",
        accountId: "account",
        accountLabel: "Launchpad · Alice",
      });
      expect(test.calls.map((call) => call.name)).toEqual(["get_workspace", "get_user"]);
    }),
  );
  it.effect.each(["lp-42", "https://linear.app/launchpad/issue/LP-42/title"])(
    "reads %s",
    (reference) =>
      Effect.gen(function* () {
        const test = yield* mcpFixture();
        expect(
          yield* readLinearIssue({ ...input, issue: reference }).pipe(test.provide),
        ).toMatchObject({
          identifier: issue.id,
          issueId: issue.uuid,
          title: issue.title,
          status: issue.status,
          assignee: issue.assignee,
          originalDescription: issue.description,
        });
        expect(test.calls.find((call) => call.name === "get_issue")?.arguments).toEqual({
          id: "LP-42",
        });
      }),
  );
  it.effect.each([
    "https://linear.app/foreign/issue/LP-42",
    "https://linear.app.attacker.test/launchpad/issue/LP-42",
    "https://user@linear.app/launchpad/issue/LP-42",
    "http://linear.app/launchpad/issue/LP-42",
    "LP-42\nquery { secrets }",
  ])("rejects invalid input %s", (reference) =>
    Effect.gen(function* () {
      const test = yield* mcpFixture();
      expect(
        yield* readLinearIssue({ ...input, issue: reference }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "invalid_input" });
      expect(test.requests).toHaveLength(0);
    }),
  );
  it.effect("rejects changed workspace identity", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture((name) =>
        Effect.succeed(name === "get_workspace" ? { ...workspace, id: "other" } : undefined),
      );
      expect(yield* readLinearIssue(input).pipe(test.provide, Effect.flip)).toMatchObject({
        code: "forbidden",
      });
    }),
  );
  it.effect.each([
    { ...issue, url: "https://attacker.test/LP-42" },
    { ...issue, id: "LP-43" },
    { ...issue, uuid: "different" },
  ])("rejects mismatched returned issue %#", (value) =>
    Effect.gen(function* () {
      const test = yield* mcpFixture((name) =>
        Effect.succeed(name === "get_issue" ? value : undefined),
      );
      expect(
        yield* readLinearIssue({ ...input, issueId: "issue-id" }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "unavailable" });
    }),
  );
  it.effect("preserves nullable display fields and bounds descriptions without losing images", () =>
    Effect.gen(function* () {
      const description =
        '"'.repeat(30000) +
        '\n<linear-image>{"attrs":{"src":"https://uploads.linear.app/workspace/image?signature=expires"}}</linear-image>';
      const test = yield* mcpFixture((name) =>
        Effect.succeed(
          name === "get_issue"
            ? { ...issue, description, status: null, assignee: null }
            : undefined,
        ),
      );
      const result = yield* readLinearIssue(input).pipe(test.provide);
      expect(result.status).toBeNull();
      expect(result.assignee).toBeNull();
      expect(result.description).toContain("Description truncated");
      const { originalDescription, ...display } = result;
      expect(new TextEncoder().encode(encodeJson(display)).length).toBeLessThan(48 * 1024);
      expect(originalDescription.length).toBeGreaterThan(result.description.length);
      expect(result.originalDescription).toContain(
        "![image](<https://uploads.linear.app/workspace/image>)",
      );
    }),
  );
  it("leaves malformed editor nodes unchanged", () => {
    expect(normalizeLinearMarkdown("<linear-image>broken</linear-image>")).toBe(
      "<linear-image>broken</linear-image>",
    );
  });
  it.effect.each([
    { status: 401, code: "auth_required" },
    { status: 403, code: "forbidden" },
    { status: 404, code: "not_found" },
    { status: 429, code: "unavailable" },
    { status: 503, code: "unavailable" },
  ])("classifies HTTP $status without leaking content", ({ status, code }) =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(() =>
        Effect.succeed(new Response("private upstream content", { status })),
      );
      const result = yield* readLinearIssue(input).pipe(test.provide, Effect.flip);
      expect(result.code).toBe(code);
      expect(result.message).not.toContain("private");
    }),
  );
  it.effect.each([
    { message: "Could not find referenced Issue.", code: "not_found" },
    { message: "Invalid private query details", code: "unavailable" },
  ])("classifies MCP invalid_request: $code", ({ message, code }) =>
    Effect.gen(function* () {
      const test = yield* mcpFixture((name) =>
        Effect.succeed(
          name === "get_issue"
            ? {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: encodeJson({
                      error: "invalid_request",
                      message,
                      status: 400,
                      requestId: "private-request-id",
                    }),
                  },
                ],
              }
            : undefined,
        ),
      );
      const result = yield* readLinearIssue(input).pipe(test.provide, Effect.flip);
      expect(result.code).toBe(code);
      expect(result.message).not.toContain(message);
      expect(result.message).not.toContain("private-request-id");
    }),
  );
  it.effect("rejects tool errors and oversized responses", () =>
    Effect.gen(function* () {
      for (const value of [
        { isError: true, content: [{ type: "text", text: "private provider details" }] },
        { content: [{ type: "text", text: "x".repeat(270000) }] },
      ]) {
        const test = yield* mcpFixture(() => Effect.succeed(value));
        expect(yield* readLinearIssue(input).pipe(test.provide, Effect.flip)).toMatchObject({
          code: "unavailable",
        });
      }
    }),
  );
});
