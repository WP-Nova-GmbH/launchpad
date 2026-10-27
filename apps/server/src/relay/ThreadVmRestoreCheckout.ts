import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadCheckoutClaims } from "./ThreadCheckoutClaim.ts";
import { workspaceGit as git, workspaceGitText as gitText } from "./ThreadWorkspaceGit.ts";
import { scanWorkspaceFiles, workspaceFileHash, workspaceFailure } from "./ThreadWorkspaceFiles.ts";

const encodeInspection = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
/** Adopt an attested cold disk in a fresh one-thread VM. This never checks out,
 * resets, cleans or copies workspace files. Ordinary move reservations still
 * protect occupied main checkouts; only this restore path adopts existing work. */
export const adoptThreadVmRestoreCheckout = Effect.fn("ThreadVmRestoreCheckout.adopt")(
  function* (input: {
    threadId: string;
    operationId: string;
    generation: number;
    projectId: string;
    manifestSha256: string;
    repositoryRoot: string;
    checkoutPath: string;
    branch: string | null;
    worktreesRoot: string;
  }) {
    const sql = yield* SqlClient.SqlClient,
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const fail = () =>
      workspaceFailure(
        "Saved checkout does not match this frozen restore. Files were left untouched.",
      );
    const assertOwner = Effect.gen(function* () {
      const fence = yield* makeThreadExecutionFence(sql).get(input.threadId);
      if (
        !fence ||
        fence.phase !== "frozen" ||
        fence.operationId !== input.operationId ||
        fence.generation !== input.generation ||
        fence.projectId !== input.projectId ||
        input.generation <= 1
      )
        return yield* fail();
      const [project] = yield* sql`SELECT 1 FROM projection_projects
        WHERE project_id=${input.projectId} AND workspace_root=${input.repositoryRoot} AND deleted_at IS NULL`;
      const busy = yield* sql`SELECT 1 FROM projection_projects WHERE project_id!=${input.projectId}
        UNION ALL SELECT 1 FROM projection_threads WHERE thread_id!=${input.threadId}
        UNION ALL SELECT 1 FROM thread_execution_work WHERE completed=0 OR relay_completed=0
        UNION ALL SELECT 1 FROM provider_session_runtime WHERE status NOT IN ('stopped','error')
        UNION ALL SELECT 1 FROM checkout_operation_paths
        UNION ALL SELECT 1 FROM thread_checkout_claims WHERE operation_id!=${input.operationId} AND phase!='released' LIMIT 1`;
      if (!project || busy.length) return yield* fail();
    });
    yield* assertOwner;
    const mode =
      input.checkoutPath === input.repositoryRoot ? ("main" as const) : ("worktree" as const);
    if (mode === "worktree" && !input.checkoutPath.startsWith(input.worktreesRoot + path.sep))
      return yield* fail();
    for (const root of [input.repositoryRoot, input.checkoutPath, path.dirname(input.checkoutPath)])
      if (path.resolve(root) !== root || (yield* fs.realPath(root)) !== root) return yield* fail();
    if (
      (yield* fs.realPath(yield* gitText(input.checkoutPath, ["rev-parse", "--show-toplevel"]))) !==
      input.checkoutPath
    )
      return yield* fail();
    const common = yield* fs.realPath(
      yield* gitText(input.checkoutPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    if (
      common !== path.join(input.repositoryRoot, ".git") ||
      (yield* fs.stat(common)).type !== "Directory"
    )
      return yield* fail();
    const gitDir = yield* fs.realPath(
      yield* gitText(input.checkoutPath, ["rev-parse", "--absolute-git-dir"]),
    );
    if (gitDir !== common && !gitDir.startsWith(path.join(common, "worktrees") + path.sep))
      return yield* fail();
    for (const marker of [
      "index.lock",
      "HEAD.lock",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ])
      if (yield* fs.exists(path.join(gitDir, marker))) return yield* fail();
    const head = yield* gitText(input.checkoutPath, ["rev-parse", "HEAD^{commit}"]);
    const symbolic = yield* git(
      input.checkoutPath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { allowFailure: true },
    );
    if (
      (symbolic.code !== 0 && symbolic.code !== 1) ||
      (symbolic.code === 0 ? symbolic.stdout.trim() : null) !== input.branch
    )
      return yield* fail();
    const inspection = yield* encodeInspection({
      head,
      branch: input.branch,
      index: yield* workspaceFileHash(path.join(gitDir, "index")),
      files: (yield* scanWorkspaceFiles(input.checkoutPath)).files,
    });
    const workspaceSha256 = NodeCrypto.createHash("sha256").update(inspection).digest("hex");
    const claims = makeThreadCheckoutClaims(sql);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertOwner;
        const prior = yield* claims.get(input.operationId);
        if (prior) {
          if (
            prior.phase !== "installed" ||
            prior.threadId !== input.threadId ||
            prior.generation !== input.generation ||
            prior.projectId !== input.projectId ||
            prior.repositoryRoot !== input.repositoryRoot ||
            prior.checkoutPath !== input.checkoutPath ||
            prior.mode !== mode ||
            prior.branch !== input.branch ||
            prior.manifestSha256 !== input.manifestSha256 ||
            prior.workspaceSha256 !== workspaceSha256
          )
            return yield* fail();
          return { ...prior, head };
        }
        yield* sql`INSERT INTO thread_checkout_claims(operation_id,thread_id,generation,project_id,repository_root,checkout_path,mode,branch,manifest_sha256,workspace_sha256,inspection_json,phase)
        VALUES(${input.operationId},${input.threadId},${input.generation},${input.projectId},${input.repositoryRoot},${input.checkoutPath},${mode},${input.branch},${input.manifestSha256},${workspaceSha256},${inspection},'installed')`;
        yield* sql`INSERT INTO thread_checkout_claim_projects(operation_id,project_id) VALUES(${input.operationId},${input.projectId})`;
        return { ...(yield* claims.get(input.operationId))!, head };
      }),
    );
  },
);
