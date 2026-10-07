import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { AuthClientLabel, AuthSessionUser, authSessionAuthor } from "./auth.ts";
const decodeUser = Schema.decodeUnknownSync(AuthSessionUser);
const decodeLabel = Schema.decodeSync(AuthClientLabel);

it("reads old identity JSON and keeps email out of durable author snapshots", () => {
  const user = decodeUser({
    userId: "account",
    displayName: "Alice",
    imageUrl: null,
  });
  expect(user.email).toBeUndefined();
  expect(authSessionAuthor({ ...user, email: "alice@example.com" })).toEqual({
    userId: "account",
    displayName: "Alice",
    imageUrl: null,
  });
});
it("normalizes valid labels and rejects blank or oversized labels", () => {
  expect(decodeLabel("  My phone  ")).toBe("My phone");
  expect(() => decodeLabel(" ")).toThrow();
  expect(() => decodeLabel("a".repeat(81))).toThrow();
});
