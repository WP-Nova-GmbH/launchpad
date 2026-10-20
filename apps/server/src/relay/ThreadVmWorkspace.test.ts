import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { SecretStorePersistError, ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  make,
  ProcessRunner,
  type ProcessRunInput,
  type ProcessRunOutput,
} from "../processRunner.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import { downloadThreadVmRepositoryUpload } from "./ThreadVmRepositoryUpload.ts";
import {
  prepareThreadVmWorkspace,
  THREAD_VM_WORKSPACE_SECRET,
  type ThreadVmWorkspaceInput,
} from "./ThreadVmWorkspace.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const output = (stdout = "", code = 0): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const scope = {
  allocationId: "allocation",
  threadId: ThreadId.make("thread"),
  repositoryId: "repository",
  generation: 2,
};
const vm = {
  operationId: "operation",
  scope,
  environmentId: "vm",
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  environmentCredential: "narrow-credential",
  cloudMintPublicKey: "key",
};
const fixture = Effect.fnUntraced(function* (options: { lfs?: boolean; submodule?: boolean } = {}) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  const source = `${dir}/source`,
    workspace = `${dir}/workspace`,
    bundlePath = `${dir}/repository.bundle`;
  const runner = yield* make();
  yield* fs.makeDirectory(source);
  const git = (args: ReadonlyArray<string>) =>
    runner
      .run({ command: "git", args, cwd: source })
      .pipe(Effect.tap((r) => Effect.sync(() => assert.equal(r.code, 0, r.stderr))));
  yield* git(["init", "-b", "main"]);
  yield* git(["config", "user.name", "VM Test"]);
  yield* git(["config", "user.email", "vm@example.test"]);
  yield* fs.writeFileString(`${source}/README.md`, "uploaded commit\n");
  yield* fs.writeFileString(
    `${source}/t3.json`,
    encode({
      scripts: [
        {
          name: "Setup",
          command: "echo unsafe-early-setup >> setup-count",
          runOnWorktreeCreate: true,
        },
      ],
    }),
  );
  if (options.lfs)
    yield* fs.writeFileString(
      `${source}/.gitattributes`,
      "README.md filter=lfs diff=lfs merge=lfs -text\n",
    );
  yield* git(["add", "."]);
  yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "upload"]);
  if (options.submodule) {
    const commit = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
    yield* git(["update-index", "--add", "--cacheinfo", `160000,${commit},dependency`]);
    yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "gitlink"]);
  }
  const revision = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
  yield* git(["update-ref", "refs/t3/transfer/head", revision]);
  yield* git(["bundle", "create", bundlePath, "refs/t3/transfer/head"]);
  const bytes = yield* fs.readFile(bundlePath),
    sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  yield* fs.writeFileString(`${source}/README.md`, "later local changes\n");
  yield* git(["add", "."]);
  yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "later"]);
  const input: ThreadVmWorkspaceInput = {
    operationId: vm.operationId,
    scope,
    canonicalKey: "github.com/acme/project",
    branch: "main",
    revision,
  };
  const values = new Map<string, Uint8Array>([
    [THREAD_VM_IDENTITY_SECRET, new TextEncoder().encode(encode(vm))],
  ]);
  const calls: Array<ProcessRunInput> = [];
  let version = "codex-cli 0.159.3",
    loginCode = 0,
    truncateTree = false,
    fetchWait = Effect.void;
  const fetchEntered = yield* Deferred.make<void>();
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore, {
        get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
        set: (name, value) =>
          Effect.sync(() => {
            values.set(name, value);
          }),
        create: (name, value) =>
          Effect.suspend(() => {
            if (values.has(name))
              return Effect.fail(
                new SecretStorePersistError({ resource: name, cause: "already exists" }),
              );
            values.set(name, value);
            return Effect.void;
          }),
        remove: () => Effect.die("must not remove setup state"),
        getOrCreateRandom: () => Effect.die("must not create an identity"),
      }),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("vm")),
      }),
      Effect.provideService(ProcessRunner, {
        run: (request) =>
          Effect.gen(function* () {
            calls.push(request);
            if (request.command === "codex")
              return output(
                request.args[0] === "--version" ? version : "",
                request.args[0] === "login" ? loginCode : 0,
              );
            if (request.args.includes("fetch")) {
              yield* Deferred.succeed(fetchEntered, undefined);
              yield* fetchWait;
            }
            if (truncateTree && request.args.includes("ls-tree"))
              return { ...output("100644 blob hidden README.md"), stdoutTruncated: true };
            return yield* runner.run(request);
          }),
      }),
    );
  const repository = { bundlePath, objectFormat: "sha1" as const, sha256 };
  const upload = {
    operationId: NodeCrypto.randomUUID(),
    threadId: scope.threadId,
    sourceEnvironmentId: EnvironmentId.make("source"),
    generation: 1,
    branch: "main",
    revision,
    objectFormat: "sha1" as const,
    bundle: {
      sha256,
      sizeBytes: bytes.length,
      chunks: [{ artifactId: NodeCrypto.randomUUID(), sha256, sizeBytes: bytes.length }],
    },
  };
  const run = (request = input) =>
    prepareThreadVmWorkspace(request, workspace, "reset", repository).pipe(provide);
  return {
    fs,
    dir,
    workspace,
    input,
    values,
    calls,
    provide,
    repository,
    upload,
    bytes,
    run,
    fetchEntered,
    setVersion: (value: string) => {
      version = value;
    },
    setLoginCode: (value: number) => {
      loginCode = value;
    },
    setTruncateTree: () => {
      truncateTree = true;
    },
    setFetchWait: (value: Effect.Effect<void>) => {
      fetchWait = value;
    },
  };
});
const test = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("uploaded VM reset workspace", () => {
  it.effect(
    "returns to the uploaded commit without cloning, credentials, a remote or early setup",
    () =>
      test(
        Effect.gen(function* () {
          const f = yield* fixture();
          const repository = yield* downloadThreadVmRepositoryUpload({
            repository: f.upload,
            threadId: scope.threadId,
            scratchRoot: f.dir,
            readArtifact: () => Effect.succeed(Stream.fromIterable([f.bytes])),
          });
          const ready = yield* prepareThreadVmWorkspace(
            f.input,
            f.workspace,
            "reset",
            repository,
          ).pipe(f.provide);
          assert.equal(ready.state, "ready");
          assert.equal(yield* f.fs.readFileString(`${f.workspace}/README.md`), "uploaded commit\n");
          assert.equal(yield* f.fs.exists(`${f.workspace}/setup-count`), false);
          assert.equal(
            f.calls.filter((c) => c.command === "bash" || c.args.includes("clone")).length,
            0,
          );
          assert.isFalse(
            f.calls.some(
              (c) => c.args.some((a) => a.includes("https://")) || Boolean(c.env?.GH_TOKEN),
            ),
          );
          assert.notInclude(yield* f.fs.readFileString(`${f.workspace}/.git/config`), "[remote");
          const count = f.calls.length;
          assert.deepEqual(
            yield* prepareThreadVmWorkspace(f.input, f.workspace, "reset", repository).pipe(
              f.provide,
            ),
            ready,
          );
          assert.equal(f.calls.length, count);
        }),
      ),
  );
  it.effect(
    "rejects direct setup and reset without an uploaded bundle before spawning anything",
    () =>
      test(
        Effect.gen(function* () {
          const f = yield* fixture();
          for (const purpose of ["initial", "reset"] as const) {
            const request = {
              ...f.input,
              scope: { ...scope, generation: purpose === "initial" ? 1 : 2 },
            };
            f.values.set(
              THREAD_VM_IDENTITY_SECRET,
              new TextEncoder().encode(encode({ ...vm, scope: request.scope })),
            );
            assert.equal(
              (yield* prepareThreadVmWorkspace(request, f.workspace, purpose).pipe(
                f.provide,
                Effect.flip,
              )).code,
              "repository_unavailable",
            );
          }
          assert.lengthOf(f.calls, 0);
          assert.isFalse(f.values.has(THREAD_VM_WORKSPACE_SECRET));
        }),
      ),
  );
  it.effect("retains a failed partial checkout instead of retrying or overwriting it", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture();
        const request = { ...f.input, revision: "a".repeat(40) };
        assert.equal((yield* f.run(request).pipe(Effect.flip)).code, "repository_unavailable");
        yield* f.fs.writeFileString(`${f.workspace}/keep`, "existing work");
        assert.equal((yield* f.run(request).pipe(Effect.flip)).code, "setup_unconfirmed");
        assert.equal(yield* f.fs.readFileString(`${f.workspace}/keep`), "existing work");
      }),
    ),
  );
  it.effect("retains uncertainty after an interrupted local-bundle import", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture(),
          release = yield* Deferred.make<void>();
        f.setFetchWait(Deferred.await(release));
        const fiber = yield* f.run().pipe(Effect.forkChild);
        yield* Deferred.await(f.fetchEntered);
        yield* Fiber.interrupt(fiber);
        assert.equal((yield* f.run().pipe(Effect.flip)).code, "setup_unconfirmed");
        assert.lengthOf(
          f.calls.filter((c) => c.args.includes("fetch")),
          1,
        );
      }),
    ),
  );
  it.effect("admits at most one concurrent local-bundle import", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture();
        const results = yield* Effect.all(
          Array.from({ length: 4 }, () => f.run().pipe(Effect.exit)),
          { concurrency: "unbounded" },
        );
        assert.isAtLeast(results.filter(Exit.isSuccess).length, 1);
        assert.lengthOf(
          f.calls.filter((c) => c.args.includes("fetch")),
          1,
        );
      }),
    ),
  );
  it.effect("restores the uploaded commit before provider sign-in", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setLoginCode(1);
        const ready = yield* f.run();
        assert.equal(ready.state, "ready");
        assert.equal(yield* f.fs.readFileString(`${f.workspace}/README.md`), "uploaded commit\n");
        assert.isFalse(
          f.calls.some((call) => call.command === "codex" && call.args[0] === "login"),
        );
      }),
    ),
  );
  it.effect("rejects stale identity, an incompatible provider version and existing work", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal(
          (yield* f
            .run({ ...f.input, scope: { ...scope, threadId: ThreadId.make("other") } })
            .pipe(Effect.flip)).code,
          "identity_changed",
        );
        f.setVersion("codex-cli 0.159.4");
        assert.equal((yield* f.run().pipe(Effect.flip)).code, "provider_version_mismatch");
        f.setVersion("codex-cli 0.159.3");
        yield* f.fs.makeDirectory(f.workspace);
        yield* f.fs.writeFileString(`${f.workspace}/keep`, "work");
        assert.equal((yield* f.run().pipe(Effect.flip)).code, "workspace_not_empty");
        assert.equal(yield* f.fs.readFileString(`${f.workspace}/keep`), "work");
        assert.isFalse(f.values.has(THREAD_VM_WORKSPACE_SECRET));
      }),
    ),
  );
  it.effect("rejects unsupported submodules, LFS and incomplete Git inspection", () =>
    test(
      Effect.gen(function* () {
        for (const options of [{ submodule: true }, { lfs: true }, {}]) {
          const f = yield* fixture(options);
          if (Object.keys(options).length === 0) f.setTruncateTree();
          assert.equal(
            (yield* f.run().pipe(Effect.flip)).code,
            Object.keys(options).length === 0
              ? "repository_unavailable"
              : "unsupported_git_dependencies",
          );
        }
      }),
    ),
  );
  it.effect("rejects corrupt, oversized, duplicated or cross-thread upload chunks", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const repository of [
          { ...f.upload, threadId: ThreadId.make("other") },
          { ...f.upload, bundle: { ...f.upload.bundle, sha256: "a".repeat(64) } },
          {
            ...f.upload,
            bundle: {
              ...f.upload.bundle,
              chunks: [...f.upload.bundle.chunks, ...f.upload.bundle.chunks],
            },
          },
          { ...f.upload, bundle: { ...f.upload.bundle, sizeBytes: 64 * 1024 ** 3 + 1 } },
        ]) {
          yield* downloadThreadVmRepositoryUpload({
            repository,
            threadId: scope.threadId,
            scratchRoot: f.dir,
            readArtifact: () => Effect.succeed(Stream.fromIterable([f.bytes])),
          }).pipe(Effect.flip);
        }
        assert.isFalse(yield* f.fs.exists(f.workspace));
      }),
    ),
  );
});
