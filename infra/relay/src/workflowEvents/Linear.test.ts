import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkflowEventFacts } from "@t3tools/contracts/workflows";
import * as Store from "../workflowSources/Store.ts";
import { normalize, matches, verify } from "./Linear.ts";
import { issue, revocation, trigger, sign } from "./test-fixture.ts";
const decodeFacts = Schema.decodeEffect(WorkflowEventFacts);
const time = Date.parse("2026-10-16T12:00:00Z");
describe("Linear event identity and matching", () => {
  it.effect("pins create facts and ignores transport/subscription copies", () =>
    Effect.gen(function* () {
      const original = issue(time);
      const a = yield* normalize(original, "native-app");
      const b = yield* normalize(
        {
          ...original,
          webhookTimestamp: time + 1000,
          webhookId: "subscription-2",
          actor: { id: "other" },
          updatedFrom: { description: "transport copies may omit unrelated old values" },
        },
        "native-app",
      );
      expect(a).toMatchObject({
        kind: "issue",
        entered: false,
        facts: { teamId: "team", stateId: "ready", labelIds: [] },
      });
      expect(a.kind !== "ignored" && a.eventKey).toBe(b.kind !== "ignored" && b.eventKey);
      if (a.kind === "issue") expect(matches(trigger, a)).toBe(true);
    }),
  );
  it.effect.each([
    { old: {}, entry: false },
    { old: { stateId: "ready" }, entry: false },
    { old: { stateId: "todo" }, entry: true },
    { old: { stateId: null }, entry: true },
  ])("classifies old state $old", ({ old, entry }) =>
    Effect.gen(function* () {
      const e = yield* normalize(issue(time, { action: "update", updatedFrom: old }), "native-app");
      expect(e).toMatchObject({ kind: "issue", entered: entry });
      if (e.kind === "issue") {
        expect(matches({ ...trigger, event: "entered_status", stateId: "ready" }, e)).toBe(entry);
        expect(matches(trigger, e)).toBe(false);
      }
    }),
  );
  it.effect(
    "requires all selected labels and rejects team/status mismatch or archived issues",
    () =>
      Effect.gen(function* () {
        const base = issue(time);
        const e = yield* normalize(
          { ...base, data: { ...base.data, labelIds: ["b", "a", "a"] } },
          "native-app",
        );
        if (e.kind !== "issue") throw new Error("Expected issue");
        expect(e.facts.labelIds).toEqual(["a", "b"]);
        expect(matches({ ...trigger, labelIds: ["a", "b"] }, e)).toBe(true);
        expect(matches({ ...trigger, labelIds: ["missing"] }, e)).toBe(false);
        expect(matches({ ...trigger, teamId: "other" }, e)).toBe(false);
        const archived = yield* normalize(
          { ...base, data: { ...base.data, archivedAt: base.createdAt } },
          "native-app",
        );
        if (archived.kind === "issue") expect(matches(trigger, archived)).toBe(false);
      }),
  );
  it.effect("distinguishes real re-entry and other source identity", () =>
    Effect.gen(function* () {
      const a = yield* normalize(
        issue(time, { action: "update", updatedFrom: { stateId: "todo" } }),
        "native-app",
      );
      const b = yield* normalize(
        issue(time + 1, { action: "update", updatedFrom: { stateId: "todo" } }),
        "native-app",
      );
      const c = yield* normalize(issue(time), "other-app");
      expect(a.kind !== "ignored" && a.eventKey).not.toBe(b.kind !== "ignored" && b.eventKey);
      expect(a.kind !== "ignored" && a.eventKey).not.toBe(c.kind !== "ignored" && c.eventKey);
    }),
  );
  it.effect.each([
    { data: { ...issue(time).data, teamId: undefined } },
    { data: { ...issue(time).data, labelIds: undefined } },
    { data: { ...issue(time).data, labelIds: Array.from({ length: 101 }, (_, i) => String(i)) } },
    { data: { ...issue(time).data, stateId: null } },
    { createdAt: "not-a-time" },
    { updatedFrom: { stateId: 42 } },
  ])("fails closed on malformed routing facts %#", (extra) =>
    Effect.gen(function* () {
      expect(yield* normalize(issue(time, extra), "native-app").pipe(Effect.flip)).toMatchObject({
        status: 400,
      });
    }),
  );
  it.effect("classifies irrelevant events before Issue data and binds revocation to the app", () =>
    Effect.gen(function* () {
      expect(
        yield* normalize(issue(time, { action: "remove", data: undefined }), "native-app"),
      ).toMatchObject({ kind: "ignored" });
      expect(yield* normalize(revocation(time), "native-app")).toMatchObject({
        kind: "revocation",
      });
      expect(yield* normalize(revocation(time), "other-app").pipe(Effect.flip)).toMatchObject({
        status: 400,
      });
    }),
  );
  it.effect("verifies exact bytes and strict signature encoding", () =>
    Effect.gen(function* () {
      const text = Store.json(issue(time));
      const bytes = new TextEncoder().encode(text);
      const signature = yield* sign(text);
      expect(yield* verify(bytes, signature, "webhook-test-secret")).toBe(true);
      for (const bad of [undefined, "abc", signature + "00", "z".repeat(64)])
        expect(yield* verify(bytes, bad, "webhook-test-secret")).toBe(false);
      expect(
        yield* verify(new TextEncoder().encode(text + " "), signature, "webhook-test-secret"),
      ).toBe(false);
    }),
  );
  it.effect.each(
    [
      ["a".repeat(119), "a".repeat(119)],
      ["a".repeat(120), "a".repeat(120)],
      ["a".repeat(121), "a".repeat(120)],
      ["a".repeat(118) + "🚀tail", "a".repeat(118) + "🚀"],
      ["a".repeat(119) + "🚀", "a".repeat(119)],
      ["🚀".repeat(61), "🚀".repeat(60)],
    ].map(([title, expected]) => ({ title, expected })),
  )("bounds Unicode previews without splitting pairs %#", ({ title, expected }) =>
    Effect.gen(function* () {
      const original = issue(time);
      const event = yield* normalize(
        { ...original, data: { ...original.data, title } },
        "native-app",
      );
      if (event.kind !== "issue") throw new Error("Expected issue");
      const facts = yield* decodeFacts(event.facts);
      expect(facts.title).toBe(expected);
      expect(facts.title.length).toBeLessThanOrEqual(120);
      const other = yield* normalize(original, "native-app");
      expect(other.kind !== "ignored" && other.eventKey).toBe(event.eventKey);
    }),
  );
});
