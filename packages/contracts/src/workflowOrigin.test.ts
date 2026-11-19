import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { WorkflowOrigin, sameWorkflowOrigin } from "./workflowOrigin.ts";

const origin = {
  kind: "automation",
  organizationId: "org",
  repositoryId: "repo",
  workflowId: "flow",
  source: {
    provider: "linear",
    applicationId: "app",
    workspaceId: "workspace",
    connectionId: "connection",
    grantId: "grant",
  },
  occurrenceId: "event",
} as const;
it("requires every automation identity and compares source and occurrence", () => {
  const decode = Schema.decodeUnknownSync(WorkflowOrigin);
  expect(decode(origin)).toEqual(origin);
  for (const key of Object.keys(origin)) {
    const invalid = { ...origin, [key]: undefined };
    expect(() => decode(invalid)).toThrow();
  }
  for (const key of Object.keys(origin.source))
    expect(() => decode({ ...origin, source: { ...origin.source, [key]: "" } })).toThrow();
  expect(() => decode({ kind: "unknown", userId: "alice" })).toThrow();
  expect(() => decode({ kind: "manual", userId: "" })).toThrow();
  expect(sameWorkflowOrigin(origin, { ...origin, occurrenceId: "other" })).toBe(false);
  expect(
    sameWorkflowOrigin(origin, { ...origin, source: { ...origin.source, grantId: "other" } }),
  ).toBe(false);
});
