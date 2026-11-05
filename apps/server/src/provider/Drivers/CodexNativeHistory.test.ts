import { describe, expect, it } from "@effect/vitest";
import {
  parseCodexNativeRollout,
  repairCodexNativeHistoryOffsets,
  selectCodexNativeHistory,
} from "./CodexNativeHistory.ts";

const rootId = "01900000-0000-7000-8000-000000000001";
const childId = "01900000-0000-7000-8000-000000000002";
const revertedId = "01900000-0000-7000-8000-000000000003";
const foreignId = "01900000-0000-7000-8000-000000000004";
const name = (id: string) => `rollout-2026-10-06T12-00-00-${id}.jsonl`;
const metadata = (id: string, extra: object = {}) => ({
  id,
  session_id: rootId,
  cli_version: "0.159.3",
  history_mode: "paginated",
  ...extra,
});
const row = (ordinal: number, type: string, payload: unknown) =>
  JSON.stringify({ timestamp: "2026-10-06T12:00:00Z", ordinal, type, payload }) + "\n";
const spawn = (ordinal: number, task = "/root/child") =>
  row(ordinal, "response_item", {
    type: "function_call",
    name: "spawn_agent",
    call_id: `call-${ordinal}`,
    arguments: "opaque",
  }) +
  row(ordinal + 1, "response_item", {
    type: "function_call_output",
    call_id: `call-${ordinal}`,
    output: JSON.stringify({ task_name: task }),
  });
const root = (extra: string = "") =>
  parseCodexNativeRollout(
    name(rootId),
    row(0, "session_meta", metadata(rootId)) + spawn(1) + extra,
  );
const child = (extra: object = {}) =>
  parseCodexNativeRollout(
    name(childId),
    row(
      0,
      "session_meta",
      metadata(childId, {
        parent_thread_id: rootId,
        forked_from_id: rootId,
        agent_path: "/root/child",
        subagent_history_start_ordinal: 1,
        ...extra,
      }),
    ) + row(1, "response_item", { type: "message", role: "assistant", content: [] }),
  );
const revert = (prefix: ReturnType<typeof root>, endOrdinal = 3) =>
  parseCodexNativeRollout(
    name(rootId + "_" + revertedId),
    row(
      endOrdinal,
      "session_meta",
      metadata(rootId, {
        history_base: {
          thread_id: prefix.rolloutId,
          end_ordinal_exclusive: endOrdinal,
          end_byte_offset: prefix.offsets.get(endOrdinal),
        },
      }),
    ) + row(endOrdinal + 1, "response_item", { type: "message", role: "user", content: [] }),
  );

describe("native Codex history closure", () => {
  it("preserves different source versions throughout a conversation's native history", () => {
    const parent = parseCodexNativeRollout(
      name(rootId),
      row(0, "session_meta", metadata(rootId, { cli_version: "0.163.0-alpha.10.2" })) + spawn(1),
    );
    const result = selectCodexNativeHistory(parent.name, [parent, child()]);
    expect(result.rollouts.map((rollout) => rollout.metadata.cli_version)).toEqual([
      "0.163.0-alpha.10.2",
      "0.159.3",
    ]);
  });

  it("carries the current root, its existing child, and only the required immutable prefix", () => {
    const prefix = root(
      row(3, "response_item", { type: "message", role: "user", content: ["removed turn"] }),
    );
    const head = revert(prefix);
    const other = parseCodexNativeRollout(
      name(foreignId),
      row(0, "session_meta", metadata(foreignId, { session_id: foreignId })),
    );
    const result = selectCodexNativeHistory(head.name, [prefix, head, child(), other]);
    expect([...result.heads]).toEqual([
      [rootId, head.name],
      [childId, name(childId)],
    ]);
    expect(result.rollouts.map((r) => r.name)).toEqual([head.name, prefix.name, name(childId)]);
    const inherited = result.rollouts.find((r) => r.name === prefix.name)!;
    expect(inherited.text).not.toContain("removed turn");
    expect(inherited.records.at(-1)?.ordinal).toBe(2);
    expect(head.rolloutId).toBe(revertedId);
    expect(head.metadata.id).toBe(rootId);
  });

  it("blocks a missing child rather than exporting only the parent", () => {
    const parent = root();
    expect(() => selectCodexNativeHistory(parent.name, [parent])).toThrow(/child is missing/u);
  });

  it.each([
    { parent_thread_id: foreignId },
    { forked_from_id: foreignId },
    { session_id: foreignId },
  ])("blocks a child outside its declared ownership: %j", (change) => {
    const parent = root();
    expect(() => selectCodexNativeHistory(parent.name, [parent, child(change)])).toThrow();
  });

  it("does not transfer a child whose creation was removed by native revert", () => {
    const prefix = root();
    const head = revert(prefix, 1);
    const result = selectCodexNativeHistory(head.name, [prefix, head, child()]);
    expect([...result.heads.keys()]).toEqual([rootId]);
    expect(result.rollouts.some((r) => r.metadata.id === childId)).toBe(false);
  });

  it("rejects a prefix with a wrong byte boundary even if the ordinal is valid", () => {
    const prefix = root();
    const head = revert(prefix);
    const bad = parseCodexNativeRollout(
      head.name,
      head.text.replace(
        `"end_byte_offset":${prefix.offsets.get(3)}`,
        `"end_byte_offset":${prefix.offsets.get(3)! - 1}`,
      ),
    );
    expect(() => selectCodexNativeHistory(bad.name, [prefix, bad, child()])).toThrow(
      /byte boundary/u,
    );
  });

  it("repairs UTF-8 byte offsets after relocating a referenced file, preserving logical identities", () => {
    const prefix = root(
      row(3, "event_msg", { type: "user_message", local_images: ["/old/猫.png"] }),
    );
    const head = revert(prefix, 4);
    const moved = parseCodexNativeRollout(
      prefix.name,
      prefix.text.replace("/old/猫.png", "/new/provider/native-files/very-long-猫.png"),
    );
    const repaired = repairCodexNativeHistoryOffsets([head, moved, child()]);
    const current = repaired.find((r) => r.name === head.name)!;
    expect(current.metadata.history_base).toEqual({
      thread_id: rootId,
      end_ordinal_exclusive: 4,
      end_byte_offset: moved.offsets.get(4),
    });
    expect(current.metadata.id).toBe(rootId);
    expect(current.rolloutId).toBe(revertedId);
    expect(() => selectCodexNativeHistory(current.name, repaired)).not.toThrow();
  });

  it("rejects ambiguous child histories instead of picking by filename date", () => {
    const parent = root();
    const original = child();
    const alternate = parseCodexNativeRollout(name(childId + "_" + revertedId), original.text);
    expect(() => selectCodexNativeHistory(parent.name, [parent, original, alternate])).toThrow(
      /ambiguous history heads/u,
    );
  });

  it("rejects incomplete spawn receipts and unverified bulk creation", () => {
    const incomplete = parseCodexNativeRollout(
      name(rootId),
      row(0, "session_meta", metadata(rootId)) +
        row(1, "response_item", { type: "function_call", name: "spawn_agent", call_id: "pending" }),
    );
    expect(() => selectCodexNativeHistory(incomplete.name, [incomplete])).toThrow(
      /settled receipt/u,
    );
    const bulk = parseCodexNativeRollout(
      name(rootId),
      incomplete.text.replace("spawn_agent", "spawn_agents_on_csv"),
    );
    expect(() => selectCodexNativeHistory(bulk.name, [bulk])).toThrow(/Bulk native/u);
  });

  it("does not omit a child declared through an unverified collaboration-event format", () => {
    const parent = parseCodexNativeRollout(
      name(rootId),
      row(0, "session_meta", metadata(rootId)) +
        row(1, "event_msg", {
          type: "item_completed",
          item: {
            type: "CollabAgentToolCall",
            tool: "spawnAgent",
            receiver_thread_ids: [childId],
          },
        }),
    );
    expect(() => selectCodexNativeHistory(parent.name, [parent, child()])).toThrow(
      /not been verified/u,
    );
  });

  it("rejects corrupt record ordering, unsafe filenames, and wrong conversation IDs", () => {
    const good = parseCodexNativeRollout(
      name(rootId),
      root().text.replace("0.159.3", "0.163.0-alpha.10.2"),
    );
    expect(() => parseCodexNativeRollout("../" + good.name, good.text)).toThrow();
    expect(() =>
      parseCodexNativeRollout(good.name, good.text.replace('"ordinal":2', '"ordinal":3')),
    ).toThrow();
    expect(() => parseCodexNativeRollout(name(childId), good.text)).toThrow(/identity/u);
  });
});
