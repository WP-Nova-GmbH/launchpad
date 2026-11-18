import { GitCommandError } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type ProcessRunner, CurrentWorkflowCommand } from "../processRunner.ts";
import { type GitVcsDriver, workflowGitEnvironment } from "../vcs/GitVcsDriver.ts";
import { VmCoordinatorProcess } from "../vmWorkloadCommand.ts";

class WorkflowVmGitError extends Schema.TaggedError<WorkflowVmGitError>()("WorkflowVmGitError", {
  message: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}
const failure = (message: string) => new WorkflowVmGitError({ message });
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const pullBody = Schema.Struct({
  head: Schema.String,
  base: Schema.String,
  title: Schema.String,
  body: Schema.String,
});
const encodePullBody = Schema.encodeSync(Schema.fromJsonString(pullBody));
const MAX_COMMIT_BYTES = 128 * 1024;
const oid = /^[a-f0-9]{40}$/u;
const decodePullRequest = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged_at: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ full_name: Schema.String }) }),
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
});
export type WorkflowVmPullRequest = typeof decodePullRequest.Type;

export function workflowVmPublishingGit(
  runner: ProcessRunner["Service"],
  directory: string,
  repository: string,
) {
  const remote = `https://github.com/${repository}.git`;
  const run = Effect.fnUntraced(function* (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env?: NodeJS.ProcessEnv;
      readonly stdin?: string;
      readonly limit?: number;
    } = {},
  ) {
    const beginOwner = yield* CurrentWorkflowCommand;
    const owner = beginOwner ? yield* beginOwner : null;
    const result = yield* runner
      .run({
        command,
        args,
        cwd: directory,
        env: options.env ?? workflowGitEnvironment,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(owner ? { owner } : {}),
        timeout: "45 seconds",
        maxOutputBytes: options.limit ?? 1024 * 1024,
        outputMode: "error",
      })
      .pipe(Effect.provideService(VmCoordinatorProcess, true));
    if (result.timedOut || result.stdoutTruncated || result.stdoutInvalidUtf8)
      return yield* failure("GitHub publishing output was incomplete.");
    return result;
  });
  const git = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly token?: Redacted.Redacted<string>;
      readonly allowNonZero?: boolean;
      readonly limit?: number;
      readonly identity?: {
        readonly name: string;
        readonly email: string;
        readonly dates: readonly [string, string];
      };
    } = {},
  ) {
    const env = options.token
      ? {
          ...workflowGitEnvironment,
          GIT_ALLOW_PROTOCOL: "https",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${Redacted.value(options.token)}`).toString("base64")}`,
          GIT_TRACE_CURL: "0",
          GIT_CURL_VERBOSE: "0",
        }
      : options.identity
        ? {
            ...workflowGitEnvironment,
            GIT_AUTHOR_NAME: options.identity.name,
            GIT_AUTHOR_EMAIL: options.identity.email,
            GIT_COMMITTER_NAME: options.identity.name,
            GIT_COMMITTER_EMAIL: options.identity.email,
            GIT_AUTHOR_DATE: options.identity.dates[0],
            GIT_COMMITTER_DATE: options.identity.dates[1],
          }
        : workflowGitEnvironment;
    const output = yield* run(
      "/usr/bin/git",
      [
        "--no-replace-objects",
        "--git-dir",
        directory,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "http.followRedirects=false",
        "-c",
        "core.fsync=objects,reference",
        ...args,
      ],
      {
        env,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      },
    );
    if (output.code !== 0 && !options.allowNonZero)
      return yield* failure("Git could not verify or publish the saved result.");
    return output;
  });
  const commitObject = Effect.fnUntraced(function* (sha: string) {
    if (!oid.test(sha)) return yield* failure("The prepared commit ID is invalid.");
    const output = yield* git(["cat-file", "commit", sha], {
      allowNonZero: true,
      limit: MAX_COMMIT_BYTES,
    });
    return output.code === 0 ? new TextEncoder().encode(output.stdout) : null;
  });
  const restoreObject = Effect.fnUntraced(function* (sha: string, bytes: Uint8Array) {
    if (!oid.test(sha) || bytes.byteLength === 0 || bytes.byteLength > MAX_COMMIT_BYTES)
      return yield* failure("The saved publishing commit is invalid.");
    const input = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => failure("The saved publishing commit is invalid."),
    });
    const { stdout: hashed } = yield* git(["hash-object", "-t", "commit", "--stdin", "--"], {
      stdin: input,
    });
    if (hashed.trim() !== sha)
      return yield* Effect.fail(
        failure("The saved publishing commit does not match its recorded ID."),
      );
    yield* git(["hash-object", "-t", "commit", "-w", "--stdin", "--"], { stdin: input });
    return input;
  });

  const api = Effect.fnUntraced(function* <A, E>(
    token: Redacted.Redacted<string>,
    path: string,
    decode: (text: string) => Effect.Effect<A, E>,
    body?: {
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
    },
  ) {
    const config =
      [
        `header = ${encodeString(`Authorization: Bearer ${Redacted.value(token)}`)}`,
        ...(body ? [`data-binary = ${encodeString(encodePullBody(body))}`] : []),
      ].join("\n") + "\n";
    const response = yield* run(
      "/usr/bin/curl",
      [
        "--disable",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--max-time",
        "40",
        "--config",
        "-",
        "--write-out",
        "\n%{http_code}",
        "--request",
        body ? "POST" : "GET",
        "--header",
        "Content-Type: application/json",
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        "--",
        `https://api.github.com/repos/${repository}${path}`,
      ],
      { stdin: config, limit: 4 * 1024 * 1024 },
    );
    const boundary = response.stdout.lastIndexOf("\n");
    const status = response.stdout.slice(boundary + 1);
    if (response.code === 0 && status === "401")
      return yield* new WorkflowVmGitError({
        message: "GitHub rejected this pull request credential.",
        status: 401,
      });
    if (response.code !== 0 || (status !== "200" && status !== "201"))
      return yield* failure(
        status === "403"
          ? "The GitHub App cannot access this workflow's pull request."
          : "GitHub could not confirm the workflow's pull request.",
      );
    return yield* decode(response.stdout.slice(0, boundary));
  });
  const decodePull = Schema.decodeEffect(Schema.fromJsonString(decodePullRequest));
  const decodePulls = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(decodePullRequest)));
  return {
    git,
    execute: ((input) =>
      git(input.args, {
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        ...(input.maxOutputBytes === undefined ? {} : { limit: input.maxOutputBytes }),
      }).pipe(
        Effect.map(({ code, ...output }) => ({
          ...output,
          exitCode: code ?? ChildProcessSpawner.ExitCode(1),
        })),
        Effect.mapError(
          () =>
            new GitCommandError({
              operation: input.operation,
              command: "git",
              cwd: directory,
              detail:
                "Could not check the exact publishing commit in the protected Git repository.",
            }),
        ),
      )) satisfies GitVcsDriver["Service"]["execute"],
    commitObject,
    restoreObject,
    remoteHead: Effect.fnUntraced(function* (token: Redacted.Redacted<string>, ref: string) {
      const { stdout } = yield* git(["ls-remote", "--refs", "--", remote, ref], { token });
      const [sha, observed, ...rest] = stdout.trimEnd().split(/\s/u);
      if (!sha) return null;
      if (rest.length || observed !== ref || !oid.test(sha))
        return yield* failure("GitHub returned an invalid workflow branch ref.");
      return sha;
    }),
    push: (token: Redacted.Redacted<string>, ref: string, from: string | null, sha: string) =>
      git(
        [
          "push",
          "--porcelain",
          "--no-mirror",
          "--no-follow-tags",
          "--no-recurse-submodules",
          `--force-with-lease=${ref}:${from ?? ""}`,
          "--",
          remote,
          `${sha}:${ref}`,
        ],
        { token },
      ),
    getPull: (token: Redacted.Redacted<string>, number: number) =>
      api(token, `/pulls/${number}`, decodePull),
    listPulls: (token: Redacted.Redacted<string>, branch: string) =>
      api(
        token,
        `/pulls?${new URLSearchParams({
          state: "all",
          per_page: "20",
          head: `${repository.split("/")[0]}:${branch}`,
        })}`,
        decodePulls,
      ),
    openPull: (
      token: Redacted.Redacted<string>,
      body: {
        readonly head: string;
        readonly base: string;
        readonly title: string;
        readonly body: string;
      },
    ) => api(token, "/pulls", decodePull, body),
  };
}
