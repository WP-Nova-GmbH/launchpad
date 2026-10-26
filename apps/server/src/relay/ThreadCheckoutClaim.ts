import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { scanWorkspaceFiles, workspaceFailure, workspaceFileHash } from "./ThreadWorkspaceFiles.ts";
import { workspaceGit as git, workspaceGitText as gitText } from "./ThreadWorkspaceGit.ts";
import { ThreadWorkspaceManifest } from "./ThreadWorkspaceTransfer.ts";

interface CheckoutClaim {
  readonly operationId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly checkoutPath: string;
  readonly mode: "main" | "worktree";
  readonly freshCheckout: number;
  readonly branch: string | null;
  readonly manifestSha256: string;
  readonly workspaceSha256: string;
  readonly inspectionJson: string;
  readonly backupDirectory: string | null;
  readonly backupSha256: string | null;
  readonly releaseReason: "activated" | "cancelled" | null;
  readonly phase: "reserved" | "installing" | "installed" | "rolling-back" | "released";
}
const Request = Schema.Struct({
  operationId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  projectId: Schema.NonEmptyString,
  manifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  workspace: ThreadWorkspaceManifest,
  stagedWorkspaceRoot: Schema.NonEmptyString,
  worktreesRoot: Schema.NonEmptyString,
});
export type ThreadCheckoutRequest = typeof Request.Type;
type Request = ThreadCheckoutRequest;
const decode = Schema.decodeUnknownEffect(Request);
const encodeWorkspace = Schema.encodeEffect(Schema.fromJsonString(ThreadWorkspaceManifest));
const encodeInspection = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A reservation outlives its caller. Uncertain installation must be reconciled, never timed out. */
export function makeThreadCheckoutClaims(sql: SqlClient.SqlClient) {
  const fence = makeThreadExecutionFence(sql);
  const get = Effect.fn("ThreadCheckoutClaims.get")(function* (operationId: string) {
    const [claim] = yield* sql<CheckoutClaim>`SELECT operation_id AS "operationId",
      thread_id AS "threadId", generation, project_id AS "projectId",
      repository_root AS "repositoryRoot", checkout_path AS "checkoutPath", mode, branch, fresh_checkout AS "freshCheckout",
      manifest_sha256 AS "manifestSha256", workspace_sha256 AS "workspaceSha256", inspection_json AS "inspectionJson", backup_directory AS "backupDirectory", backup_sha256 AS "backupSha256", release_reason AS "releaseReason", phase
      FROM thread_checkout_claims WHERE operation_id = ${operationId}`;
    return claim ?? null;
  });
  const assertFrozen = Effect.fnUntraced(function* (
    input: Pick<Request, "threadId" | "generation" | "operationId" | "projectId">,
  ) {
    const current = yield* fence.get(input.threadId);
    if (
      !current ||
      current.phase !== "frozen" ||
      current.generation !== input.generation ||
      current.operationId !== input.operationId ||
      current.projectId !== input.projectId
    )
      return yield* workspaceFailure(
        "Checkout installation requires this move's frozen destination.",
      );
    const active = yield* sql`SELECT 1 FROM thread_execution_work
      WHERE thread_id = ${input.threadId} AND completed = 0 LIMIT 1`;
    if (active.length) return yield* workspaceFailure("Destination work has not stopped.");
    const runtime =
      yield* sql`SELECT 1 FROM provider_session_runtime WHERE thread_id = ${input.threadId}
      AND status NOT IN ('stopped', 'error') LIMIT 1`;
    if (runtime.length) return yield* workspaceFailure("The destination provider has not stopped.");
  });
  const projects = sql<{
    projectId: string;
    root: string;
  }>`SELECT project_id AS "projectId", workspace_root AS root
    FROM projection_projects WHERE deleted_at IS NULL ORDER BY project_id`;
  const threads = sql<{
    threadId: string;
    projectId: string;
    worktreePath: string | null;
  }>`SELECT thread_id AS "threadId",
    project_id AS "projectId", worktree_path AS "worktreePath" FROM projection_threads
    WHERE deleted_at IS NULL OR EXISTS (SELECT 1 FROM thread_cleanup_fences c WHERE c.thread_id = projection_threads.thread_id) ORDER BY thread_id`;
  const assertCheckoutRoot = Effect.fnUntraced(function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    if ((yield* fs.realPath(yield* gitText(root, ["rev-parse", "--show-toplevel"]))) !== root)
      return yield* workspaceFailure("The project must point to a Git checkout root.");
  });
  const inspect = Effect.fnUntraced(function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const head = yield* gitText(root, ["rev-parse", "HEAD^{commit}"]);
    const branchResult = yield* git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowFailure: true,
    });
    if (branchResult.code !== 0 && branchResult.code !== 1)
      return yield* workspaceFailure("Cannot inspect the destination branch.");
    const gitDir = yield* fs.realPath(yield* gitText(root, ["rev-parse", "--absolute-git-dir"]));
    for (const marker of [
      "index.lock",
      "HEAD.lock",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]) {
      if (yield* fs.exists(path.join(gitDir, marker))) return null;
    }
    if (
      (yield* git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored", "-z"]))
        .stdout
    )
      return null;
    // Git status deliberately hides assume-unchanged/skip-worktree entries.
    // They cannot establish that the destination is safe to replace.
    const flags = (yield* git(root, ["ls-files", "-v", "-z"])).stdout.split("\0").filter(Boolean);
    if (flags.some((entry) => entry[0] !== "H")) return null;
    // Empty directories do not appear in Git status, but are still somebody's data.
    const tracked = new Set(
      (yield* git(root, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean),
    );
    const directories = new Set<string>();
    for (const file of tracked) {
      let parent = path.dirname(file);
      while (parent !== ".") {
        directories.add(parent);
        parent = path.dirname(parent);
      }
    }
    const { files } = yield* scanWorkspaceFiles(root);
    if (files.some((file) => !(file.kind === "directory" ? directories : tracked).has(file.path)))
      return null;
    return {
      head,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
      index: yield* workspaceFileHash(path.join(gitDir, "index")),
      files,
    };
  });
  const reserve = Effect.fn("ThreadCheckoutClaims.reserve")(function* (request: Request) {
    const input = yield* decode(request);
    const workspaceSha256 = NodeCrypto.createHash("sha256")
      .update(yield* encodeWorkspace(input.workspace))
      .digest("hex");
    if (input.workspace.threadId !== input.threadId)
      return yield* workspaceFailure("The incoming workspace belongs to another thread.");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* assertFrozen(input);
    const prior = yield* get(input.operationId);
    if (prior) {
      if (
        prior.threadId !== input.threadId ||
        prior.generation !== input.generation ||
        prior.projectId !== input.projectId ||
        prior.manifestSha256 !== input.manifestSha256 ||
        prior.workspaceSha256 !== workspaceSha256 ||
        prior.phase === "released"
      )
        return yield* workspaceFailure("This checkout reservation belongs to a different move.");
      return prior;
    }
    const knownProjects = yield* projects,
      knownThreads = yield* threads;
    const project = knownProjects.find((item) => item.projectId === input.projectId);
    if (!project) return yield* workspaceFailure("The destination project no longer exists.");
    const repositoryRoot = yield* fs.realPath(project.root);
    yield* assertCheckoutRoot(repositoryRoot);
    const aliases: string[] = [];
    for (const candidate of knownProjects) {
      // An unreadable unrelated project must not stop a move. The selected project is required above.
      if (
        (yield* fs.realPath(candidate.root).pipe(Effect.orElseSucceed(() => null))) ===
        repositoryRoot
      )
        aliases.push(candidate.projectId);
    }
    let occupied = false;
    for (const thread of knownThreads) {
      if (thread.threadId === input.threadId) continue;
      const root =
        thread.worktreePath ??
        knownProjects.find((item) => item.projectId === thread.projectId)?.root;
      if (
        root &&
        (yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => null))) === repositoryRoot
      )
        occupied = true;
    }
    const state = occupied ? null : yield* inspect(repositoryRoot);
    const staged = yield* fs.realPath(input.stagedWorkspaceRoot);
    if (
      (yield* gitText(staged, ["rev-parse", "HEAD"])) !== input.workspace.head ||
      (yield* gitText(repositoryRoot, ["rev-parse", "--show-object-format"])) !==
        input.workspace.objectFormat
    )
      return yield* workspaceFailure("The staged workspace or destination Git format changed.");
    // A main-checkout update may advance its branch, but must not discard local commits.
    const ancestor = state
      ? yield* git(staged, ["merge-base", "--is-ancestor", state.head, input.workspace.head], {
          allowFailure: true,
        })
      : null;
    const main = state !== null && ancestor?.code === 0 && state.branch === input.workspace.branch;
    const mode = main ? ("main" as const) : ("worktree" as const);
    let checkoutPath = repositoryRoot;
    let branch = input.workspace.branch;
    if (!main) {
      yield* fs.makeDirectory(input.worktreesRoot, { recursive: true, mode: 0o700 });
      const worktreesRoot = yield* fs.realPath(input.worktreesRoot);
      if (
        worktreesRoot === repositoryRoot ||
        worktreesRoot.startsWith(`${repositoryRoot}${path.sep}`)
      )
        return yield* workspaceFailure("Move worktrees must live outside the project checkout.");
      const suffix = NodeCrypto.createHash("sha256")
        .update(input.operationId)
        .digest("hex")
        .slice(0, 24);
      checkoutPath = path.join(worktreesRoot, `move-${suffix}`);
      // Keep the source branch if free. Never force one branch into two checkouts.
      if (
        branch &&
        (yield* git(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
          allowFailure: true,
        })).code !== 1
      )
        branch = `t3code/move-${suffix}`;
      if (yield* fs.exists(checkoutPath))
        return yield* workspaceFailure("The destination worktree path is already occupied.");
      if (
        branch &&
        (yield* git(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
          allowFailure: true,
        })).code !== 1
      )
        return yield* workspaceFailure("The destination branch is already occupied.");
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertFrozen(input);
        if (
          !NodeUtil.isDeepStrictEqual(yield* projects, knownProjects) ||
          !NodeUtil.isDeepStrictEqual(yield* threads, knownThreads)
        )
          return yield* workspaceFailure(
            "Destination use changed while reserving the checkout; retry the move.",
          );
        const projectOperations = yield* sql`SELECT 1 FROM checkout_operation_projects
          WHERE project_id IN ${sql.in(aliases)} LIMIT 1`;
        const operations = yield* sql<{ path: string }>`SELECT path FROM checkout_operation_paths`;
        if (
          projectOperations.length ||
          operations.some(({ path: pending }) =>
            [repositoryRoot, checkoutPath].some(
              (root) =>
                pending === root ||
                pending.startsWith(`${root}${path.sep}`) ||
                root.startsWith(`${pending}${path.sep}`),
            ),
          )
        )
          return yield* workspaceFailure("Checkout operations have not been confirmed stopped.");
        const conflicts = yield* sql`SELECT 1 FROM thread_checkout_claims WHERE phase <> 'released'
        AND (repository_root = ${repositoryRoot} OR checkout_path = ${checkoutPath}) LIMIT 1`;
        if (conflicts.length)
          return yield* workspaceFailure("Another move has reserved this repository.");
        yield* sql`INSERT INTO thread_checkout_claims
        (operation_id, thread_id, generation, project_id, repository_root, checkout_path, mode,
         branch, manifest_sha256, workspace_sha256, inspection_json, phase)
        VALUES (${input.operationId}, ${input.threadId}, ${input.generation}, ${input.projectId},
        ${repositoryRoot}, ${checkoutPath}, ${mode}, ${branch}, ${input.manifestSha256}, ${workspaceSha256},
        ${yield* encodeInspection(main ? state : null)}, 'reserved')`;
        for (const projectId of aliases)
          yield* sql`INSERT INTO thread_checkout_claim_projects (operation_id, project_id)
        VALUES (${input.operationId}, ${projectId})`;
        return (yield* get(input.operationId))!;
      }),
    );
  });
  const reserveFresh = Effect.fn("ThreadCheckoutClaims.reserveFresh")(function* (
    request: Request,
    root: string,
  ) {
    const input = yield* decode(request),
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    yield* assertFrozen(input);
    const workspaceSha256 = NodeCrypto.createHash("sha256")
      .update(yield* encodeWorkspace(input.workspace))
      .digest("hex");
    const prior = yield* get(input.operationId);
    if (prior) {
      if (
        prior.freshCheckout !== 1 ||
        prior.threadId !== input.threadId ||
        prior.projectId !== input.projectId ||
        prior.generation !== input.generation ||
        prior.repositoryRoot !== root ||
        prior.manifestSha256 !== input.manifestSha256 ||
        prior.workspaceSha256 !== workspaceSha256 ||
        prior.phase === "released"
      )
        return yield* workspaceFailure("Fresh VM checkout intent changed.");
      return prior;
    }
    if (
      input.workspace.threadId !== input.threadId ||
      (yield* fs.realPath(root)) !== root ||
      (yield* fs.realPath(path.dirname(root))) !== path.dirname(root) ||
      (yield* fs.readDirectory(root)).length
    )
      return yield* workspaceFailure("The fresh VM checkout is no longer empty.");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertFrozen(input);
        const [project] =
          yield* sql`SELECT 1 FROM projection_projects WHERE project_id=${input.projectId} AND workspace_root=${root} AND deleted_at IS NULL`;
        const busy = yield* sql`SELECT 1 FROM projection_threads WHERE thread_id!=${input.threadId}
        UNION ALL SELECT 1 FROM projection_projects WHERE project_id!=${input.projectId}
        UNION ALL SELECT 1 FROM checkout_operation_paths
        UNION ALL SELECT 1 FROM thread_checkout_claims WHERE phase!='released' LIMIT 1`;
        if (!project || busy.length || (yield* fs.readDirectory(root)).length)
          return yield* workspaceFailure("The VM checkout was claimed by another operation.");
        yield* sql`INSERT INTO thread_checkout_claims
        (operation_id,thread_id,generation,project_id,repository_root,checkout_path,mode,branch,manifest_sha256,workspace_sha256,inspection_json,phase,fresh_checkout)
        VALUES (${input.operationId},${input.threadId},${input.generation},${input.projectId},${root},${root},'main',${input.workspace.branch},${input.manifestSha256},${workspaceSha256},'[]','reserved',1)`;
        yield* sql`INSERT INTO thread_checkout_claim_projects(operation_id,project_id) VALUES (${input.operationId},${input.projectId})`;
        return (yield* get(input.operationId))!;
      }),
    );
  });
  const assertPaths = Effect.fnUntraced(function* (claim: CheckoutClaim) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [project] = yield* sql<{
      root: string;
    }>`SELECT workspace_root AS root FROM projection_projects
      WHERE project_id = ${claim.projectId} AND deleted_at IS NULL`;
    if (
      !project ||
      (yield* fs.realPath(project.root)) !== claim.repositoryRoot ||
      (yield* fs.realPath(claim.repositoryRoot)) !== claim.repositoryRoot ||
      (claim.mode === "worktree" &&
        (yield* fs.realPath(path.dirname(claim.checkoutPath))) !== path.dirname(claim.checkoutPath))
    )
      return yield* workspaceFailure("Destination paths changed after reservation.");
    if (claim.freshCheckout !== 1) yield* assertCheckoutRoot(claim.repositoryRoot);
  });
  const verifyLocation = Effect.fn("ThreadCheckoutClaims.verifyLocation")(function* (
    operationId: string,
  ) {
    const claim = yield* get(operationId);
    if (!claim) return yield* workspaceFailure("The checkout reservation is missing.");
    yield* assertPaths(claim);
  });
  const assertUnchanged = Effect.fn("ThreadCheckoutClaims.assertUnchanged")(function* (
    operationId: string,
  ) {
    const claim = yield* get(operationId);
    if (!claim || (claim.phase !== "reserved" && claim.phase !== "installing"))
      return yield* workspaceFailure("This checkout is not reserved for installation.");
    yield* assertFrozen(claim);
    yield* assertPaths(claim);
    if (
      claim.mode === "main" &&
      claim.freshCheckout !== 1 &&
      (yield* encodeInspection(yield* inspect(claim.repositoryRoot))) !== claim.inspectionJson
    )
      return yield* workspaceFailure(
        "The destination checkout changed after reservation. Its files were left untouched.",
      );
  });
  const beginInstall = Effect.fn("ThreadCheckoutClaims.beginInstall")(function* (
    operationId: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const claim = yield* get(operationId);
    if (!claim || claim.phase !== "reserved")
      return yield* workspaceFailure(
        "Reconcile this checkout's installation before writing again.",
      );
    yield* assertFrozen(claim);
    yield* assertPaths(claim);
    if (claim.freshCheckout === 1) {
      if ((yield* fs.readDirectory(claim.checkoutPath)).length)
        return yield* workspaceFailure("The fresh VM checkout changed after reservation.");
    } else if (claim.mode === "main") {
      if ((yield* encodeInspection(yield* inspect(claim.repositoryRoot))) !== claim.inspectionJson)
        return yield* workspaceFailure(
          "The destination checkout changed after reservation. Its files were left untouched.",
        );
    } else {
      if (
        (yield* fs.exists(claim.checkoutPath)) ||
        (claim.branch &&
          (yield* git(
            claim.repositoryRoot,
            ["show-ref", "--verify", "--quiet", `refs/heads/${claim.branch}`],
            { allowFailure: true },
          )).code !== 1)
      )
        return yield* workspaceFailure("The reserved worktree or branch became occupied.");
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertFrozen(claim);
        const changed = yield* sql`UPDATE thread_checkout_claims SET phase = 'installing'
        WHERE operation_id = ${operationId} AND phase = 'reserved' RETURNING operation_id`;
        if (!changed.length)
          return yield* workspaceFailure("Another worker owns this checkout installation.");
        return { ...claim, phase: "installing" as const };
      }),
    );
  });
  const cancelReservation = Effect.fn("ThreadCheckoutClaims.cancelReservation")(function* (
    operationId: string,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const claim = yield* get(operationId);
        if (!claim) return;
        if (claim.phase === "released") {
          if (claim.releaseReason === "cancelled") return;
          return yield* workspaceFailure("An activated checkout cannot be cancelled.");
        }
        if (claim.phase !== "reserved")
          return yield* workspaceFailure(
            "Confirm installed checkout cleanup before releasing its reservation.",
          );
        yield* assertFrozen(claim);
        yield* sql`UPDATE thread_checkout_claims SET phase = 'released', release_reason = 'cancelled' WHERE operation_id = ${operationId}`;
      }),
    );
  });
  return {
    get,
    reserve,
    reserveFresh,
    verifyLocation,
    assertUnchanged,
    beginInstall,
    cancelReservation,
  };
}
