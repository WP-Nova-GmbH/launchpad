import { RelayThreadVmWorkspaceInput } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProcessRunner } from "../processRunner.ts";
import { CODEX_CONVERSATION_TRANSFER_VERSION } from "../provider/Drivers/CodexConversationTransfer.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";

export const ThreadVmWorkspaceInput = RelayThreadVmWorkspaceInput;
export type ThreadVmWorkspaceInput = typeof ThreadVmWorkspaceInput.Type;
const WorkspaceRecord = Schema.Struct({
  input: ThreadVmWorkspaceInput,
  purpose: Schema.optionalKey(Schema.Literals(["initial", "reset"])),
  repositoryBundleSha256: Schema.optionalKey(Schema.String),
  workspaceRoot: Schema.NonEmptyString,
  createdAt: Schema.String,
  state: Schema.Literals(["started", "ready", "failed"]),
  errorCode: Schema.NullOr(Schema.String),
});
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(WorkspaceRecord));
const encodeInput = Schema.encodeSync(Schema.fromJsonString(ThreadVmWorkspaceInput));
export const THREAD_VM_WORKSPACE_SECRET = "thread-vm-workspace";
export class ThreadVmWorkspaceError extends Schema.TaggedError<ThreadVmWorkspaceError>()(
  "ThreadVmWorkspaceError",
  {
    code: Schema.Literals([
      "identity_changed",
      "setup_unconfirmed",
      "workspace_not_empty",
      "repository_unavailable",
      "unsupported_git_dependencies",
      "provider_version_mismatch",
      "setup_failed",
    ]),
  },
) {
  override get message() {
    return `VM workspace preparation is blocked (${this.code}).`;
  }
}
const isWorkspaceError = Schema.is(ThreadVmWorkspaceError);
const failure = (code: ThreadVmWorkspaceError["code"]) => new ThreadVmWorkspaceError({ code });

/** Called by the isolated guest bootstrap, before the server or any provider session starts. */
export const prepareThreadVmWorkspace = Effect.fn("ThreadVmWorkspace.prepare")(
  function* (
    input: ThreadVmWorkspaceInput,
    workspaceRoot = "/workspace/project",
    purpose: "initial" | "reset" = "initial",
    repository?: {
      readonly bundlePath: string;
      readonly objectFormat: "sha1" | "sha256";
      readonly sha256: string;
    },
  ) {
    const vm = yield* readInstalledThreadVm().pipe(
      Effect.mapError(() => failure("identity_changed")),
    );
    if (
      !vm ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId) ||
      vm.operationId !== input.operationId ||
      vm.scope.allocationId !== input.scope.allocationId ||
      vm.scope.threadId !== input.scope.threadId ||
      vm.scope.repositoryId !== input.scope.repositoryId ||
      vm.scope.generation !== input.scope.generation ||
      (purpose === "initial" ? vm.scope.generation !== 1 : vm.scope.generation <= 1)
    )
      return yield* failure("identity_changed");
    const secrets = yield* ServerSecretStore;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (
      !path.isAbsolute(workspaceRoot) ||
      path.normalize(workspaceRoot) !== workspaceRoot ||
      (repository &&
        (!path.isAbsolute(repository.bundlePath) || !/^[0-9a-f]{64}$/u.test(repository.sha256)))
    )
      return yield* failure("identity_changed");
    const prior = yield* secrets
      .get(THREAD_VM_WORKSPACE_SECRET)
      .pipe(Effect.mapError(() => failure("setup_unconfirmed")));
    if (Option.isSome(prior)) {
      const record = yield* decodeRecord(new TextDecoder().decode(prior.value)).pipe(
        Effect.mapError(() => failure("setup_unconfirmed")),
      );
      if (
        record.workspaceRoot !== workspaceRoot ||
        (record.purpose ?? "initial") !== purpose ||
        encodeInput(record.input) !== encodeInput(input) ||
        (purpose === "reset" &&
          (!repository || record.repositoryBundleSha256 !== repository.sha256))
      )
        return yield* failure("identity_changed");
      if (record.state !== "ready") return yield* failure("setup_unconfirmed");
      return record;
    }
    // Legacy ready checkouts remain usable; fresh VMs can only receive an upload.
    if (purpose !== "reset" || !repository) return yield* failure("repository_unavailable");
    // A fresh allocation has no inherited checkout. Never clean or overwrite a path on retry.
    if (yield* fs.exists(workspaceRoot)) return yield* failure("workspace_not_empty");
    const runner = yield* ProcessRunner;
    const run = (
      command: string,
      args: ReadonlyArray<string>,
      code: ThreadVmWorkspaceError["code"],
      env?: NodeJS.ProcessEnv,
      cwd?: string,
      allowTruncatedOutput = false,
    ) =>
      runner
        .run({
          command,
          args,
          env,
          cwd,
          timeout: "15 minutes",
          maxOutputBytes: allowTruncatedOutput ? 65536 : 8 * 1024 * 1024,
          outputMode: allowTruncatedOutput ? "truncate" : "error",
        })
        .pipe(
          Effect.mapError(() => failure(code)),
          Effect.flatMap((result) =>
            result.code === 0 &&
            !result.timedOut &&
            (allowTruncatedOutput || (!result.stdoutTruncated && !result.stdoutInvalidUtf8))
              ? Effect.succeed(result.stdout)
              : Effect.fail(failure(code)),
          ),
        );
    yield* run("git", ["check-ref-format", "--branch", input.branch], "repository_unavailable");
    const version = yield* run("codex", ["--version"], "provider_version_mismatch");
    if (version.trim() !== `codex-cli ${CODEX_CONVERSATION_TRANSFER_VERSION}`)
      return yield* failure("provider_version_mismatch");
    // Reset restores local data while the prompt queue remains paused. Provider
    // sign-in can happen through the fresh environment's normal settings later.
    const record = {
      input,
      purpose,
      repositoryBundleSha256: repository.sha256,
      workspaceRoot,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      state: "started" as const,
      errorCode: null,
    };
    const save = (value: typeof WorkspaceRecord.Type) =>
      encodeRecord(value).pipe(
        Effect.flatMap((encoded) =>
          secrets.set(THREAD_VM_WORKSPACE_SECRET, new TextEncoder().encode(encoded)),
        ),
        Effect.mapError(() => failure("setup_unconfirmed")),
      );
    // Exclusive, fsynced creation is the cross-process admission. An unfinished attempt is
    // deliberately retained: its setup script may still be running after a lost caller.
    yield* secrets
      .create(THREAD_VM_WORKSPACE_SECRET, new TextEncoder().encode(yield* encodeRecord(record)))
      .pipe(Effect.mapError(() => failure("setup_unconfirmed")));
    const attempt = Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(workspaceRoot), { recursive: true });
      yield* run(
        "git",
        ["init", `--object-format=${repository.objectFormat}`, "--", workspaceRoot],
        "repository_unavailable",
        { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" },
      );
      const git = (args: ReadonlyArray<string>) =>
        run("git", ["-C", workspaceRoot, ...args], "repository_unavailable", {
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "0",
        });
      yield* git(["bundle", "verify", repository.bundlePath]);
      const head = (yield* git([
        "bundle",
        "list-heads",
        repository.bundlePath,
        "refs/t3/transfer/head",
      ])).trim();
      if (head !== `${input.revision} refs/t3/transfer/head`)
        return yield* failure("repository_unavailable");
      yield* git([
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        repository.bundlePath,
        `refs/t3/transfer/head:refs/heads/${input.branch}`,
      ]);
      yield* git(["fsck", "--full", "--strict", "--no-reflogs"]);
      const tree = yield* git(["ls-tree", "-r", input.revision]);
      if (/^160000 /m.test(tree)) return yield* failure("unsupported_git_dependencies");
      yield* git(["checkout", "-B", input.branch, input.revision, "--"]);
      if ((yield* git(["rev-parse", "HEAD"])).trim() !== input.revision)
        return yield* failure("repository_unavailable");
      const attributes = yield* runner.run({
        command: "git",
        args: ["-C", workspaceRoot, "ls-files", "-z"],
        maxOutputBytes: 8 * 1024 * 1024,
      });
      const filters = yield* runner.run({
        command: "git",
        args: ["-C", workspaceRoot, "check-attr", "-z", "--stdin", "filter"],
        stdin: attributes.stdout,
        maxOutputBytes: 8 * 1024 * 1024,
      });
      if (
        attributes.code !== 0 ||
        attributes.timedOut ||
        attributes.stdoutTruncated ||
        attributes.stdoutInvalidUtf8 ||
        filters.code !== 0 ||
        filters.timedOut ||
        filters.stdoutTruncated ||
        filters.stdoutInvalidUtf8 ||
        filters.stdout.includes("\0filter\0lfs\0")
      )
        return yield* failure("unsupported_git_dependencies");
      // Project setup runs after the retained conversation and history are installed.
      const ready = { ...record, state: "ready" as const };
      yield* save(ready);
      return ready;
    }).pipe(
      Effect.mapError((error) => (isWorkspaceError(error) ? error : failure("setup_failed"))),
    );
    return yield* attempt.pipe(
      Effect.tapError((error) => save({ ...record, state: "failed", errorCode: error.code })),
    );
  },
  Effect.mapError((error) => (isWorkspaceError(error) ? error : failure("setup_unconfirmed"))),
);
