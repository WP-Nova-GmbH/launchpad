import { describe, expect, it } from "@effect/vitest";

import { classifyApprovalRequest } from "./approvalClassification.ts";

describe("classifyApprovalRequest", () => {
  it("auto-approves file reads without consulting a model", () => {
    expect(
      classifyApprovalRequest({ requestType: "file_read_approval", detail: "cat src/a.ts" }),
    ).toEqual({
      kind: "auto-approve",
      reason: "Reading files needs no supervision.",
    });
  });

  it("consults the supervisor for commands and file changes", () => {
    expect(
      classifyApprovalRequest({ requestType: "command_execution_approval", detail: "pnpm test" }),
    ).toEqual({ kind: "consult", toolKind: "command" });
    expect(
      classifyApprovalRequest({ requestType: "apply_patch_approval", detail: "edit src/a.ts" }),
    ).toEqual({ kind: "consult", toolKind: "file-change" });
  });

  it("consults rather than auto-approving a request it cannot classify", () => {
    // `dynamic_tool_call` derives no kind server-side. Reading "no kind" as
    // "harmless" would auto-approve arbitrary tool calls.
    expect(
      classifyApprovalRequest({ requestType: "dynamic_tool_call", detail: "run something" }),
    ).toEqual({
      kind: "consult",
      toolKind: "other",
    });
    expect(classifyApprovalRequest({ requestType: undefined, detail: undefined })).toEqual({
      kind: "consult",
      toolKind: "other",
    });
  });

  describe("the category floor", () => {
    // ADR-0009: no legitimate workflow asks an agent to push, so the
    // supervisor needs no judgement about it — and a supervisor that is
    // confidently wrong about one gets no chance to be.
    const denied = [
      "git push origin main",
      "git push --force-with-lease",
      "git  push",
      "gh pr create --title x",
      "gh pr merge 12 --squash",
      "glab mr create",
      "az repos pr create --id 3",
      "npm publish --access public",
      "git remote set-url origin https://evil.test/x.git",
      "cd /repo && git push",
    ];

    for (const detail of denied) {
      it(`denies ${JSON.stringify(detail)}`, () => {
        const disposition = classifyApprovalRequest({
          requestType: "command_execution_approval",
          detail,
        });
        expect(disposition.kind).toBe("deny");
      });
    }

    const allowed = [
      "git commit -m 'wip'",
      "git status",
      "git merge main",
      "pnpm test",
      "gh --version",
      "echo pushing to the limit",
    ];

    for (const detail of allowed) {
      it(`does not deny ${JSON.stringify(detail)}`, () => {
        expect(
          classifyApprovalRequest({ requestType: "command_execution_approval", detail }).kind,
        ).toBe("consult");
      });
    }

    it("does not apply the floor to file reads", () => {
      // A file whose contents mention pushing is not a push.
      expect(
        classifyApprovalRequest({
          requestType: "file_read_approval",
          detail: "read deploy.md: git push",
        }).kind,
      ).toBe("auto-approve");
    });
  });
});
