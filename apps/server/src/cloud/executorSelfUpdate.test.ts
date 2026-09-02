import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { findSourceCheckoutRoot, syncSourceCheckout } from "./executorSelfUpdate.ts";

const release = { gitUrl: "https://github.com/acme/launchpad.git", ref: "main" };

function output(stdout: string, exitCode = 0): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(exitCode),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

/** A VcsProcess that records every command and answers rev-parse from a script. */
function fakeVcs(input: {
  readonly remoteUrl: string | null;
  readonly head: string | null;
  readonly fetched: string;
}) {
  const commands: Array<string> = [];
  const service = VcsProcess.VcsProcess.of({
    run: (request) =>
      Effect.sync(() => {
        const line = [request.command, ...request.args].join(" ");
        commands.push(line);
        if (line === "git remote get-url origin") {
          return input.remoteUrl === null ? output("", 128) : output(`${input.remoteUrl}\n`);
        }
        if (line === "git rev-parse --verify --quiet HEAD") {
          return input.head === null ? output("", 1) : output(`${input.head}\n`);
        }
        if (line === "git rev-parse FETCH_HEAD") {
          return output(`${input.fetched}\n`);
        }
        return output("");
      }),
  });
  return { commands, service };
}

const withTempDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-self-update-" });
      return yield* use(directory);
    }),
  ).pipe(Effect.orDie);

describe("findSourceCheckoutRoot", () => {
  it.effect("walks up to the workspace marker and gives up at the filesystem root", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(directory, "pnpm-workspace.yaml"), "");
        const nested = path.join(directory, "apps", "server", "src", "cloud");
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        expect(yield* findSourceCheckoutRoot(nested)).toBe(directory);
        expect(yield* findSourceCheckoutRoot(path.join(directory, "..", "nowhere-near"))).toBe(
          null,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("syncSourceCheckout", () => {
  it.effect("turns a snapshot into a checkout and updates it", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const vcs = fakeVcs({ remoteUrl: null, head: null, fetched: "abc123" });
        const outcome = yield* syncSourceCheckout({ sourceRoot: directory, release }).pipe(
          Effect.provideService(VcsProcess.VcsProcess, vcs.service),
        );
        expect(outcome).toBe("updated");
        expect(vcs.commands).toEqual([
          "git init --quiet",
          `git remote add origin ${release.gitUrl}`,
          "git -c credential.helper=!gh auth git-credential fetch --quiet --depth 1 origin main",
          "git rev-parse --verify --quiet HEAD",
          "git rev-parse FETCH_HEAD",
          "git reset --hard --quiet FETCH_HEAD",
          "pnpm install --frozen-lockfile",
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a checkout alone when it is already at the ref's head", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(directory, ".git"));
        const vcs = fakeVcs({ remoteUrl: release.gitUrl, head: "abc123", fetched: "abc123" });
        const outcome = yield* syncSourceCheckout({ sourceRoot: directory, release }).pipe(
          Effect.provideService(VcsProcess.VcsProcess, vcs.service),
        );
        expect(outcome).toBe("current");
        expect(vcs.commands.some((line) => line.startsWith("git reset"))).toBe(false);
        expect(vcs.commands.some((line) => line.startsWith("pnpm"))).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("repoints a checkout whose remote differs from the release", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(directory, ".git"));
        const vcs = fakeVcs({
          remoteUrl: "https://example.test/old.git",
          head: "old",
          fetched: "new",
        });
        const outcome = yield* syncSourceCheckout({ sourceRoot: directory, release }).pipe(
          Effect.provideService(VcsProcess.VcsProcess, vcs.service),
        );
        expect(outcome).toBe("updated");
        expect(vcs.commands).toContain(`git remote set-url origin ${release.gitUrl}`);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
