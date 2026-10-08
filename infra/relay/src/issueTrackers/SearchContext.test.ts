import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { searchInput, sealSearchCursor } from "./SearchContext.ts";

const fixture = () => {
  const values = new Map<string, string>();
  return Layer.mock(RelaySecretBox, {
    seal: (value) =>
      Effect.sync(() => {
        const reference = `opaque-${values.size}`;
        values.set(reference, value);
        return reference;
      }),
    open: (reference) => Effect.succeed(values.get(reference) ?? "invalid"),
  });
};
const base = { ownerUserId: "alice", service: "linear" as const, connectionVersion: "v1" };

describe("issue search references", () => {
  it.effect("binds pagination to the owner, service, connection and original filters", () => {
    const layer = fixture();
    return Effect.gen(function* () {
      const first = yield* searchInput({
        ...base,
        request: { query: "  queue  ", assignee: "me" },
      });
      expect(first).toEqual({ filters: { query: "queue", assignee: "me" }, cursor: undefined });
      const continuation = yield* sealSearchCursor({
        ...base,
        filters: first.filters,
        cursor: "next",
      });
      expect(yield* searchInput({ ...base, request: { continuation: continuation! } })).toEqual({
        filters: first.filters,
        cursor: "next",
      });
      for (const request of [
        { continuation: continuation!, query: "changed" },
        { continuation: "forged" },
      ]) {
        expect(yield* searchInput({ ...base, request }).pipe(Effect.flip)).toMatchObject({
          code: "invalid_input",
        });
      }
      expect(
        yield* searchInput({
          ...base,
          ownerUserId: "bob",
          request: { continuation: continuation! },
        }).pipe(Effect.flip),
      ).toMatchObject({ code: "invalid_input" });
      expect(
        yield* searchInput({
          ...base,
          connectionVersion: "v2",
          request: { continuation: continuation! },
        }).pipe(Effect.flip),
      ).toMatchObject({ code: "conflict" });
    }).pipe(Effect.provide(layer));
  });
});
