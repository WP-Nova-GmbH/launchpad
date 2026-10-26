import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ClientOrchestrationCommand } from "@t3tools/contracts";
import { issueTrackerCommandDigest, stripIssueTrackerAuthorization } from "./issueTrackerTurn.ts";

const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
  type: "thread.prompt.enqueue",
  threadId: "thread",
  commandId: "command",
  createdAt: "2026-10-02T00:00:00.000Z",
  runtimeMode: "full-access",
  interactionMode: "default",
  message: { messageId: "message", text: "Read WP-218", attachments: [] },
  issueTrackerAuthorization: "private-turn-grant",
});

describe("issue tracker transport credentials", () => {
  it("strips credentials while preserving the command", () => {
    const plain = stripIssueTrackerAuthorization(command);
    expect(plain).not.toHaveProperty("issueTrackerAuthorization");
    expect(plain.commandId).toBe(command.commandId);
    expect(JSON.stringify(plain)).not.toContain("private-turn-grant");
  });
  it.effect(
    "binds grants to exact prompt content and command identity, excluding the grant itself",
    () =>
      Effect.gen(function* () {
        const digest = yield* issueTrackerCommandDigest(command);
        expect(yield* issueTrackerCommandDigest(stripIssueTrackerAuthorization(command))).toBe(
          digest,
        );
        if (command.type !== "thread.prompt.enqueue") throw new Error("Wrong fixture");
        expect(
          yield* issueTrackerCommandDigest({
            ...command,
            message: { ...command.message, text: "Read another issue" },
          }),
        ).not.toBe(digest);
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
