import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  describeClaudeCredentials,
  describeCodexAuthStore,
  describeOpenCodeAuthStore,
  exportAuthStoreFile,
  resolveOpenCodeDataDirectory,
} from "./ProviderAccountExport.ts";

const instanceId = ProviderInstanceId.make("codex");

function jwtWith(payload: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "none" })}.${segment(payload)}.sig`;
}

describe("provider account labels", () => {
  it("names a Codex ChatGPT sign-in by the id token's email", () => {
    const content = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: jwtWith({ email: "dev@example.test" }) },
    });
    expect(describeCodexAuthStore(content)).toBe("dev@example.test");
  });

  it("names a Codex API-key sign-in without revealing the key", () => {
    expect(describeCodexAuthStore(JSON.stringify({ OPENAI_API_KEY: "sk-secret" }))).toBe(
      "OpenAI API key",
    );
  });

  it("falls back to a generic label when the store is not what it expects", () => {
    expect(describeCodexAuthStore("not json")).toBe("Codex sign-in");
    expect(describeCodexAuthStore(JSON.stringify({ tokens: {} }))).toBe("ChatGPT account");
  });

  it("names a Claude sign-in by its subscription tier", () => {
    expect(
      describeClaudeCredentials(JSON.stringify({ claudeAiOauth: { subscriptionType: "max" } })),
    ).toBe("Claude max");
    expect(describeClaudeCredentials("{}")).toBe("Claude account");
  });

  it("names an OpenCode sign-in by the providers it holds", () => {
    expect(
      describeOpenCodeAuthStore(JSON.stringify({ anthropic: { type: "api" }, openai: {} })),
    ).toBe("OpenCode: anthropic, openai");
    expect(describeOpenCodeAuthStore("{}")).toBe("OpenCode sign-in");
  });
});

describe("resolveOpenCodeDataDirectory", () => {
  it("honours XDG_DATA_HOME and falls back to ~/.local/share", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveOpenCodeDataDirectory(path, { XDG_DATA_HOME: "/xdg" })).toBe(
        path.join("/xdg", "opencode"),
      );
      expect(resolveOpenCodeDataDirectory(path, {})).toMatch(/\.local[\\/]share[\\/]opencode$/);
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));
});

describe("exportAuthStoreFile", () => {
  it.effect("reports a missing store as not signed in", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        exportAuthStoreFile({
          instanceId,
          provider: "codex",
          directory: "/definitely/not/here",
          fileName: "auth.json",
          describe: () => "unused",
          signInHint: "Sign in first.",
        }),
      );
      expect(error.reason).toBe("not_signed_in");
      expect(error.detail).toBe("Sign in first.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the store verbatim as one auth_store file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-export-" });
        yield* fileSystem.writeFileString(path.join(directory, "auth.json"), '{"a":1}');
        const exported = yield* exportAuthStoreFile({
          instanceId,
          provider: "codex",
          directory,
          fileName: "auth.json",
          describe: (content) => `label:${content.length}`,
          signInHint: "unused",
        });
        expect(exported).toEqual({
          provider: "codex",
          label: "label:7",
          payload: { kind: "auth_store", files: [{ path: "auth.json", content: '{"a":1}' }] },
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
