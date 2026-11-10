import { describe, expect, it } from "vite-plus/test";
import type { WorkflowSavedResult } from "@t3tools/contracts/workflows";
import { makeWorkflowSavedResultReader } from "./workflowSavedResults.ts";
const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b  \n";
const result: WorkflowSavedResult = {
  resultId: "11111111-1111-4111-8111-111111111111",
  stepId: "agent",
  turnId: "turn",
  turnCount: 1,
  outcome: "completed",
  createdAt: "now",
  checkpointRef: "ref",
  baselineCommitId: "base",
  commitId: "commit",
  treeId: "tree",
  patch: {
    artifactId: "22222222-2222-4222-8222-222222222222",
    sha256: "a".repeat(64),
    sizeBytes: new TextEncoder().encode(patch).length,
  },
};
describe("saved workflow result reader", () => {
  it("preserves exact bytes and bounds its selected-patch cache to two results", async () => {
    const reader = makeWorkflowSavedResultReader("account/relay/repo/job");
    let requests = 0;
    const fetch = (point: WorkflowSavedResult) => async () => {
      requests++;
      return { result: point, patch };
    };
    expect((await reader.read(result, fetch(result))).patch).toBe(patch);
    await reader.read(result, fetch(result));
    expect(requests).toBe(1);
    for (const id of [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]) {
      const next = { ...result, resultId: id };
      await reader.read(next, fetch(next));
    }
    await reader.read(result, fetch(result));
    expect(requests).toBe(4);
  });
  it("discards a reply after account, relay or access invalidation", async () => {
    const reader = makeWorkflowSavedResultReader("account/relay/repo/job");
    let resolve!: (value: { result: WorkflowSavedResult; patch: string }) => void;
    const pending = reader.read(
      result,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    reader.clear();
    resolve({ result, patch });
    await expect(pending).rejects.toThrow("view changed");
    expect(await reader.read(result, async () => ({ result, patch }))).toEqual({ result, patch });
  });
  it("rejects another result identity, digest descriptor or incomplete body without caching it", async () => {
    const reader = makeWorkflowSavedResultReader("account/relay/repo/job");
    for (const response of [
      { result: { ...result, turnId: "other" }, patch },
      { result: { ...result, patch: { ...result.patch, sha256: "b".repeat(64) } }, patch },
      { result, patch: patch.slice(1) },
    ])
      await expect(reader.read(result, async () => response)).rejects.toThrow("does not match");
    expect((await reader.read(result, async () => ({ result, patch }))).patch).toBe(patch);
  });
});
