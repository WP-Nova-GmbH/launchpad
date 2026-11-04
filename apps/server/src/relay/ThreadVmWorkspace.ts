import {
  RelayThreadVmCheckoutFailureCode,
  type RelayThreadVmCheckoutFailureProbe,
  RelayThreadVmWorkspaceInput,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { readExistingServerSecret, ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProcessRunner } from "../processRunner.ts";
import {
  decodeInstalledThreadVm,
  readInstalledThreadVm,
  THREAD_VM_IDENTITY_SECRET,
} from "./ThreadVmEnrollment.ts";

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
const BASELINE_REF = "refs/t3/transfer/head";
export class ThreadVmWorkspaceError extends Schema.TaggedError<ThreadVmWorkspaceError>()(
  "ThreadVmWorkspaceError",
  {
    code: Schema.Literals([
      "identity_changed",
      "setup_unconfirmed",
      "workspace_not_empty",
      "repository_unavailable",
      "unsupported_git_dependencies",
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
const isCheckoutFailureCode = Schema.is(RelayThreadVmCheckoutFailureCode);
const decodeSecret = (bytes: Uint8Array) =>
  Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));

/** Read the outcome of a previously attempted checkout without opening the server state. */
export const readThreadVmCheckoutFailure = Effect.fn("ThreadVmWorkspace.readCheckoutFailure")(
  function* (
    { environmentId, workspace }: RelayThreadVmCheckoutFailureProbe,
    paths: { readonly secretsDir: string; readonly environmentIdPath: string },
    workspaceRoot = "/workspace/project",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const existingId = yield* decodeSecret(yield* fs.readFile(paths.environmentIdPath));
    if (existingId.trim() !== environmentId || workspace.scope.generation !== 1) return null;
    const enrollment = yield* readExistingServerSecret(paths.secretsDir, THREAD_VM_IDENTITY_SECRET);
    if (Option.isNone(enrollment)) return null;
    const vm = yield* decodeInstalledThreadVm(yield* decodeSecret(enrollment.value));
    if (
      vm.environmentId !== environmentId ||
      vm.operationId !== workspace.operationId ||
      vm.scope.allocationId !== workspace.scope.allocationId ||
      vm.scope.threadId !== workspace.scope.threadId ||
      vm.scope.repositoryId !== workspace.scope.repositoryId ||
      vm.scope.generation !== workspace.scope.generation
    )
      return null;
    const prior = yield* readExistingServerSecret(paths.secretsDir, THREAD_VM_WORKSPACE_SECRET);
    if (Option.isNone(prior)) return null;
    const record = yield* decodeRecord(yield* decodeSecret(prior.value));
    return record.state === "failed" &&
      record.purpose === "initial" &&
      record.repositoryBundleSha256 === undefined &&
      record.workspaceRoot === workspaceRoot &&
      encodeInput(record.input) === encodeInput(workspace) &&
      isCheckoutFailureCode(record.errorCode)
      ? record.errorCode
      : null;
  },
  Effect.orElseSucceed(() => null),
);

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
    workflowGitToken?: Redacted.Redacted<string>,
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
    // The workflow-only credential permits fresh checkout; reset still consumes a bundle.
    if (
      purpose === "initial"
        ? !workflowGitToken || !/^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/iu.test(input.canonicalKey)
        : !repository || workflowGitToken
    )
      return yield* failure("repository_unavailable");
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
    const record = {
      input,
      purpose,
      ...(repository ? { repositoryBundleSha256: repository.sha256 } : {}),
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
        [
          "init",
          `--object-format=${repository?.objectFormat ?? (input.revision.length === 40 ? "sha1" : "sha256")}`,
          "--",
          workspaceRoot,
        ],
        "repository_unavailable",
        { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" },
      );
      const git = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
        run("git", ["-C", workspaceRoot, ...args], "repository_unavailable", {
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "0",
          ...env,
        });
      if (repository) {
        yield* git(["bundle", "verify", repository.bundlePath]);
        const head = (yield* git([
          "bundle",
          "list-heads",
          repository.bundlePath,
          BASELINE_REF,
        ])).trim();
        if (head !== `${input.revision} ${BASELINE_REF}`)
          return yield* failure("repository_unavailable");
        yield* git([
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          repository.bundlePath,
          `${BASELINE_REF}:refs/heads/${input.branch}`,
        ]);
      } else if (workflowGitToken) {
        yield* git(["remote", "add", "origin", `https://${input.canonicalKey}.git`]);
        yield* git(["fetch", "--no-tags", "--no-write-fetch-head", "origin", input.revision], {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Encoding.encodeBase64(`x-access-token:${Redacted.value(workflowGitToken)}`)}`,
          GIT_CONFIG_KEY_1: "http.followRedirects",
          GIT_CONFIG_VALUE_1: "false",
          GIT_TRACE_CURL: "0",
          GIT_CURL_VERBOSE: "0",
        });
        // Retain the initial commit independently of later changes to the run branch.
        yield* git(["update-ref", BASELINE_REF, input.revision]);
      }
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
