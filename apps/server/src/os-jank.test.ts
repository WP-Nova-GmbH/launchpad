// @effect-diagnostics nodeBuiltinImport:off - Builds the real on-disk layout the jank probe walks.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { assert, it } from "vite-plus/test";

import { hydratePosixHome, resolveBaseDir } from "./os-jank.ts";

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

function makeHome(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "launchpad-home-"));
}

effectIt.effect("defaults a fresh install to the Launchpad data directory", () =>
  Effect.gen(function* () {
    const home = makeHome();

    const baseDir = yield* resolveBaseDir(undefined, () => home);

    assert.equal(baseDir, NodePath.join(home, ".launchpad"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect("keeps an existing pre-rebrand install on its own directory", () =>
  Effect.gen(function* () {
    const home = makeHome();
    NodeFS.mkdirSync(NodePath.join(home, ".t3"));

    const baseDir = yield* resolveBaseDir(undefined, () => home);

    assert.equal(baseDir, NodePath.join(home, ".t3"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect("prefers the Launchpad directory once both exist", () =>
  Effect.gen(function* () {
    const home = makeHome();
    NodeFS.mkdirSync(NodePath.join(home, ".t3"));
    NodeFS.mkdirSync(NodePath.join(home, ".launchpad"));

    const baseDir = yield* resolveBaseDir(undefined, () => home);

    assert.equal(baseDir, NodePath.join(home, ".launchpad"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
