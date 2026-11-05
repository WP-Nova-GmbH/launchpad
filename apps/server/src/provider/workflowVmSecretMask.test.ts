import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { classifyApprovalRequest } from "../jobs/approvalClassification.ts";
import { workflowVmSecretMask } from "./workflowVmSecretMask.ts";

describe("workflow VM output masking", () => {
  it("withholds split chunks and preserves a masked final result", () => {
    const mask = workflowVmSecretMask({
      environment: { SECRET: "a+b[.\nsecret-tail", VARIABLE: "visible" },
      hasSecrets: true,
      secretNames: ["SECRET"],
    });
    const base = {
      eventId: EventId.make("event"),
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread"),
      createdAt: "2026-01-01T00:00:00.000Z",
    } as const;
    for (const delta of ["a+b", "[.\nsecret-", "tail"])
      expect(
        mask({ ...base, type: "content.delta", payload: { streamKind: "assistant_text", delta } }),
      ).toBeNull();
    const completed: ProviderRuntimeEvent = {
      ...base,
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "visible a+b[.\nsecret-tail",
        data: { output: "secret-tail" },
      },
      raw: {
        source: "codex.app-server.notification",
        method: "item/completed",
        payload: { text: "secret-tail" },
      },
    };
    expect(mask(completed)).toEqual({
      ...base,
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "visible [redacted]",
        data: { output: "[redacted]" },
      },
    });
    const secretInForbiddenCommand = workflowVmSecretMask({
      environment: { SECRET: "push" },
      hasSecrets: true,
      secretNames: ["SECRET"],
    })({
      ...base,
      type: "request.opened",
      payload: {
        requestType: "command_execution_approval",
        detail: "git push origin HEAD",
      },
    });
    expect(secretInForbiddenCommand?.type).toBe("request.opened");
    if (secretInForbiddenCommand?.type === "request.opened") {
      expect(secretInForbiddenCommand.payload.detail).not.toContain("push");
      expect(
        classifyApprovalRequest({
          requestType: secretInForbiddenCommand.payload.requestType,
          detail: secretInForbiddenCommand.payload.detail,
        }),
      ).toMatchObject({ kind: "deny" });
    }
  });
});
