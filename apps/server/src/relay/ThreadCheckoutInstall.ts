import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { makeThreadCheckoutClaims, type ThreadCheckoutRequest } from "./ThreadCheckoutClaim.ts";
import {
  exportThreadWorkspace,
  importThreadWorkspace,
  ThreadWorkspaceManifest,
} from "./ThreadWorkspaceTransfer.ts";
import {
  materializeWorkspaceFiles,
  scanWorkspaceFiles,
  workspaceFailure,
  workspaceFileHash,
} from "./ThreadWorkspaceFiles.ts";
import {
  decodeThreadTransferSetupOutput,
  retainThreadTransferSetupDirectories,
} from "./ThreadTransferSetupOutput.ts";
import { workspaceGit as git, workspaceGitText as gitText } from "./ThreadWorkspaceGit.ts";
import { physicalFs, workspaceFileSystem } from "./ThreadWorkspaceFileSystem.ts";

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadWorkspaceManifest));

const flushWorkspace = Effect.fnUntraced(function* (
  root: string,
  manifest: ThreadWorkspaceManifest,
) {
  const fs = yield* workspaceFileSystem;
  const path = yield* Path.Path;
  const gitDir = yield* fs.realPath(yield* gitText(root, ["rev-parse", "--absolute-git-dir"]));
  // Close each handle immediately; large repositories must not exhaust FDs.
  for (const file of [
    path.join(gitDir, "index"),
    ...manifest.files.filter((f) => f.kind !== "symlink").map((f) => path.join(root, f.path)),
    gitDir,
    root,
  ])
    yield* Effect.scoped(
      fs.open(file, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
    );
});

/** Filesystem writes cannot share SQLite's transaction. Keep a durable hold and a
 * verified original-main backup until ownership activation or explicit rollback.
 */
export function makeThreadCheckoutInstaller(sql: SqlClient.SqlClient) {
  const claims = makeThreadCheckoutClaims(sql);
  const install = Effect.fn("ThreadCheckoutInstaller.install")(function* (
    input: ThreadCheckoutRequest & {
      readonly artifactDirectory: string;
      readonly recoveryRoot: string;
      readonly freshCheckoutRoot?: string;
    },
  ) {
    const fs = yield* workspaceFileSystem;
    const path = yield* Path.Path;
    const claim = yield* input.freshCheckoutRoot
      ? claims.reserveFresh(input, input.freshCheckoutRoot)
      : claims.reserve(input);
    if (claim.phase === "installed") return claim;
    if (claim.phase !== "reserved")
      return yield* workspaceFailure(
        "Reconcile the interrupted checkout installation before retrying.",
      );
    // Re-verify artifact bytes before either a branch or a working file can change.
    const verified = yield* importThreadWorkspace({
      threadId: input.threadId,
      manifest: input.workspace,
      artifactDirectory: input.artifactDirectory,
      destinationRoot: input.recoveryRoot,
    });
    return yield* withWorkspaceLease(
      claim.checkoutPath,
      Effect.gen(function* () {
        if (claim.freshCheckout === 1) {
          const installing = yield* claims.beginInstall(input.operationId);
          // Rename can replace only this inspected empty directory. New files
          // make it fail rather than erase somebody else's work.
          yield* fs.rename(verified.workspaceRoot, claim.checkoutPath);
          if (
            (yield* gitText(claim.checkoutPath, ["rev-parse", "HEAD"])) !== input.workspace.head ||
            (yield* gitText(claim.checkoutPath, ["write-tree"])) !== input.workspace.indexTree ||
            !NodeUtil.isDeepStrictEqual(
              (yield* scanWorkspaceFiles(claim.checkoutPath)).files,
              input.workspace.files,
            )
          )
            return yield* workspaceFailure(
              "The fresh VM checkout failed verification; retain the hold.",
            );
          yield* flushWorkspace(claim.checkoutPath, input.workspace);
          const changed =
            yield* sql`UPDATE thread_checkout_claims SET phase='installed' WHERE operation_id=${input.operationId}
            AND phase='installing' AND EXISTS(SELECT 1 FROM thread_execution_fences WHERE thread_id=${input.threadId}
              AND generation=${input.generation} AND operation_id=${input.operationId} AND phase='frozen') RETURNING operation_id`;
          if (!changed.length)
            return yield* workspaceFailure("Fresh VM checkout ownership changed.");
          return { ...installing, phase: "installed" as const };
        }
        let backup: Effect.Success<ReturnType<typeof exportThreadWorkspace>> | null = null;
        if (claim.mode === "main") {
          backup = yield* exportThreadWorkspace({
            threadId: input.threadId,
            workspaceRoot: claim.repositoryRoot,
            artifactRoot: input.recoveryRoot,
          });
          const saved =
            yield* sql`UPDATE thread_checkout_claims SET backup_directory = ${backup.directory},
            backup_sha256 = ${(yield* workspaceFileHash(path.join(backup.directory, "manifest.json"))).sha256}
          WHERE operation_id = ${input.operationId} AND phase = 'reserved' RETURNING operation_id`;
          if (!saved.length)
            return yield* workspaceFailure("Another worker changed this checkout reservation.");
        }
        const installing = yield* claims.beginInstall(input.operationId);
        const token = NodeCrypto.createHash("sha256").update(input.operationId).digest("hex");
        const headRef = `refs/t3/moves/${token}/head`;
        const indexRef = `refs/t3/moves/${token}/index`;
        const bundle = path.join(yield* fs.realPath(input.artifactDirectory), "repository.bundle");
        for (const checkpoint of input.workspace.checkpoints) {
          const existing = yield* git(
            claim.repositoryRoot,
            ["rev-parse", "--verify", "--quiet", checkpoint.ref],
            { allowFailure: true },
          );
          if (
            existing.code !== 1 &&
            (existing.code !== 0 || existing.stdout.trim() !== checkpoint.commit)
          )
            return yield* workspaceFailure(
              "A destination checkpoint conflicts with the incoming thread history.",
            );
        }
        yield* git(claim.repositoryRoot, [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          bundle,
          `refs/t3/transfer/head:${headRef}`,
          `refs/t3/transfer/index:${indexRef}`,
          ...input.workspace.checkpoints.map(({ ref }) => `${ref}:${ref}`),
        ]);
        yield* claims.assertUnchanged(input.operationId);
        if (claim.mode === "worktree") {
          // No checkout here: transferring the saved index/files must not run filters or hooks.
          yield* git(claim.repositoryRoot, [
            "worktree",
            "add",
            "--no-checkout",
            "--detach",
            claim.checkoutPath,
            input.workspace.head,
          ]);
          if (claim.branch) {
            yield* git(claim.checkoutPath, [
              "update-ref",
              `refs/heads/${claim.branch}`,
              input.workspace.head,
              "",
            ]);
            yield* git(claim.checkoutPath, ["symbolic-ref", "HEAD", `refs/heads/${claim.branch}`]);
          }
        } else {
          if (!backup)
            return yield* workspaceFailure("The main checkout has no verified recovery copy.");
          // Remove only the inspected old tree. A newly created file/entry makes a
          // directory removal fail; never recursively erase unrecorded local work.
          for (const file of [...backup.manifest.files].sort(
            (a, b) => b.path.split("/").length - a.path.split("/").length,
          ))
            if (file.kind === "directory") {
              yield* Effect.tryPromise({
                try: () => physicalFs.promises.rmdir(path.join(claim.checkoutPath, file.path)),
                catch: () =>
                  workspaceFailure(
                    "The old checkout directory changed; installation remains held.",
                  ),
              });
            } else yield* fs.remove(path.join(claim.checkoutPath, file.path));
          if (claim.branch)
            yield* git(claim.checkoutPath, [
              "update-ref",
              `refs/heads/${claim.branch}`,
              input.workspace.head,
              backup.manifest.head,
            ]);
          else
            yield* git(claim.checkoutPath, [
              "update-ref",
              "--no-deref",
              "HEAD",
              input.workspace.head,
              backup.manifest.head,
            ]);
        }
        const gitDir = yield* fs.realPath(
          yield* gitText(claim.checkoutPath, ["rev-parse", "--absolute-git-dir"]),
        );
        yield* fs.copyFile(path.join(input.artifactDirectory, "index"), path.join(gitDir, "index"));
        yield* git(claim.checkoutPath, ["hash-object", "-w", "--stdin"], { stdin: "" });
        yield* materializeWorkspaceFiles(
          input.workspace.files,
          yield* fs.realPath(input.artifactDirectory),
          claim.checkoutPath,
        );
        if (
          (yield* gitText(claim.checkoutPath, ["write-tree"])) !== input.workspace.indexTree ||
          (yield* gitText(claim.checkoutPath, ["rev-parse", "HEAD"])) !== input.workspace.head ||
          !NodeUtil.isDeepStrictEqual(
            (yield* scanWorkspaceFiles(claim.checkoutPath)).files,
            input.workspace.files,
          )
        )
          return yield* workspaceFailure(
            "Installed checkout failed verification; the move remains held.",
          );
        yield* flushWorkspace(claim.checkoutPath, input.workspace);
        const changed = yield* sql`UPDATE thread_checkout_claims SET phase = 'installed'
        WHERE operation_id = ${input.operationId} AND phase = 'installing' AND EXISTS
        (SELECT 1 FROM thread_execution_fences WHERE thread_id = ${input.threadId}
          AND operation_id = ${input.operationId} AND generation = ${input.generation} AND phase = 'frozen') RETURNING operation_id`;
        if (!changed.length)
          return yield* workspaceFailure("Checkout ownership changed during installation.");
        return {
          ...installing,
          backupDirectory: backup?.directory ?? null,
          backupSha256: backup
            ? (yield* workspaceFileHash(path.join(backup.directory, "manifest.json"))).sha256
            : null,
          phase: "installed" as const,
        };
      }),
    ).pipe(
      Effect.ensuring(fs.remove(verified.workspaceRoot, { recursive: true }).pipe(Effect.ignore)),
    );
  });
  const reconcile = Effect.fn("ThreadCheckoutInstaller.reconcile")(function* (
    input: ThreadCheckoutRequest,
  ) {
    const fs = yield* workspaceFileSystem;
    const claim = yield* claims.reserve(input);
    yield* claims.verifyLocation(input.operationId);
    if (claim.phase === "installed") return claim;
    if (claim.phase !== "installing")
      return yield* workspaceFailure("The checkout has no interrupted installation to reconcile.");
    return yield* withWorkspaceLease(
      claim.checkoutPath,
      Effect.gen(function* () {
        if (
          (yield* fs.realPath(claim.checkoutPath)) !== claim.checkoutPath ||
          (yield* gitText(claim.checkoutPath, ["rev-parse", "HEAD"])) !== input.workspace.head ||
          (yield* gitText(claim.checkoutPath, ["write-tree"])) !== input.workspace.indexTree ||
          !NodeUtil.isDeepStrictEqual(
            (yield* scanWorkspaceFiles(claim.checkoutPath)).files,
            input.workspace.files,
          )
        )
          return yield* workspaceFailure(
            "Checkout installation is incomplete or changed; retain its recovery copy and hold.",
          );
        const branch = yield* git(
          claim.checkoutPath,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          { allowFailure: true },
        );
        if (
          claim.branch === null
            ? branch.code !== 1
            : branch.code !== 0 || branch.stdout.trim() !== claim.branch
        )
          return yield* workspaceFailure("The installed checkout branch changed.");
        yield* flushWorkspace(claim.checkoutPath, input.workspace);
        const updated = yield* sql`UPDATE thread_checkout_claims SET phase = 'installed'
        WHERE operation_id = ${input.operationId} AND phase = 'installing' AND EXISTS
        (SELECT 1 FROM thread_execution_fences WHERE thread_id = ${input.threadId} AND generation = ${input.generation}
          AND operation_id = ${input.operationId} AND phase = 'frozen') RETURNING operation_id`;
        if (!updated.length)
          return yield* workspaceFailure("The checkout is held by another operation.");
        return { ...claim, phase: "installed" as const };
      }),
    );
  });
  // The coordinator calls this only after a durable relay abort and confirmed
  // stopped destination work. It never releases or reactivates the source itself.
  const rollback = Effect.fn("ThreadCheckoutInstaller.rollback")(function* (
    input: ThreadCheckoutRequest & { readonly recoveryRoot: string },
  ) {
    const fs = yield* workspaceFileSystem;
    const path = yield* Path.Path;
    const prior = yield* claims.get(input.operationId);
    if (
      prior?.phase === "released" &&
      prior.releaseReason === "cancelled" &&
      prior.threadId === input.threadId &&
      prior.generation === input.generation &&
      prior.projectId === input.projectId &&
      prior.manifestSha256 === input.manifestSha256
    )
      return;
    const claim = yield* claims.reserve(input);
    if (claim.freshCheckout === 1)
      return yield* workspaceFailure(
        "The VM host must confirm removal of this dedicated checkout.",
      );
    yield* claims.verifyLocation(input.operationId);
    if (claim.phase === "reserved") return yield* claims.cancelReservation(input.operationId);
    if (
      claim.phase !== "installed" &&
      claim.phase !== "installing" &&
      claim.phase !== "rolling-back"
    )
      return yield* workspaceFailure("This checkout no longer belongs to an abortable move.");
    return yield* withWorkspaceLease(
      claim.checkoutPath,
      Effect.gen(function* () {
        const backupDirectory = claim.backupDirectory;
        let backup: ThreadWorkspaceManifest | null = null;
        let verifiedRoot: string | null = null;
        if (claim.mode === "main") {
          if (
            !backupDirectory ||
            !claim.backupSha256 ||
            (yield* workspaceFileHash(path.join(backupDirectory, "manifest.json"))).sha256 !==
              claim.backupSha256
          )
            return yield* workspaceFailure(
              "The original checkout's verified recovery copy is unavailable.",
            );
          backup = yield* decodeManifest(
            yield* fs.readFileString(path.join(backupDirectory, "manifest.json")),
          );
          verifiedRoot = (yield* importThreadWorkspace({
            threadId: input.threadId,
            manifest: backup,
            artifactDirectory: backupDirectory,
            destinationRoot: input.recoveryRoot,
          })).workspaceRoot;
        }
        return yield* Effect.gen(function* () {
          const exists = yield* fs.exists(claim.checkoutPath);
          if (!exists && claim.mode === "main")
            return yield* workspaceFailure(
              "The reserved checkout disappeared; verify cleanup before retrying.",
            );
          if (exists) {
            if ((yield* fs.realPath(claim.checkoutPath)) !== claim.checkoutPath)
              return yield* workspaceFailure("The checkout path changed before rollback.");
            const branch = yield* git(
              claim.checkoutPath,
              ["symbolic-ref", "--quiet", "--short", "HEAD"],
              { allowFailure: true },
            );
            if (
              claim.branch === null
                ? branch.code !== 1
                : branch.code !== 0 || branch.stdout.trim() !== claim.branch
            )
              return yield* workspaceFailure("The checkout branch changed before rollback.");
            const head = yield* gitText(claim.checkoutPath, ["rev-parse", "HEAD"]);
            if (head !== input.workspace.head && head !== backup?.head)
              return yield* workspaceFailure(
                "The checkout has new local commits; rollback remains held.",
              );
            const [readiness] = yield* sql<{
              output: string | null;
              started: number;
            }>`SELECT setup_output_json AS output,setup_started AS started
              FROM thread_transfer_readiness WHERE operation_id=${input.operationId}`;
            if (readiness?.started === 1 && readiness.output === null)
              return yield* workspaceFailure(
                "Destination setup has not confirmed its exit; cancellation remains held.",
              );
            const setupOutput = readiness?.output
              ? yield* decodeThreadTransferSetupOutput(readiness.output)
              : null;
            const scan = yield* scanWorkspaceFiles(claim.checkoutPath);
            const current = scan.files;
            const allowed = [
              ...input.workspace.files,
              ...(backup?.files ?? []),
              ...(setupOutput?.files ?? []),
            ];
            if (
              current.some(
                (file) => !allowed.some((expected) => NodeUtil.isDeepStrictEqual(file, expected)),
              )
            )
              return yield* workspaceFailure(
                "The checkout has new local files or edits; rollback remains held.",
              );
            if (
              scan.excludedPaths.some((relative) => !setupOutput?.excludedPaths.includes(relative))
            )
              return yield* workspaceFailure(
                "Additional checkout data needs cleanup before rollback.",
              );
            const changed = yield* sql`UPDATE thread_checkout_claims SET phase = 'rolling-back'
            WHERE operation_id = ${input.operationId} AND phase IN ('installing', 'installed', 'rolling-back')
            AND EXISTS (SELECT 1 FROM thread_execution_fences WHERE thread_id = ${input.threadId}
              AND generation = ${input.generation} AND operation_id = ${input.operationId} AND phase = 'frozen') RETURNING operation_id`;
            if (!changed.length)
              return yield* workspaceFailure("The move no longer permits destination rollback.");
            if (setupOutput?.excludedPaths.length)
              yield* retainThreadTransferSetupDirectories({
                checkoutPath: claim.checkoutPath,
                operationId: input.operationId,
                excludedPaths: setupOutput.excludedPaths,
              });
            if (claim.mode === "worktree") {
              yield* git(claim.repositoryRoot, [
                "worktree",
                "remove",
                "--force",
                claim.checkoutPath,
              ]);
            } else {
              if (!backup || !backupDirectory)
                return yield* workspaceFailure("Missing recovery copy.");
              for (const file of [...current].sort(
                (a, b) => b.path.split("/").length - a.path.split("/").length,
              )) {
                const filename = path.join(claim.checkoutPath, file.path);
                if (file.kind === "directory")
                  yield* Effect.tryPromise({
                    try: () => physicalFs.promises.rmdir(filename),
                    catch: () =>
                      workspaceFailure(
                        "Directory changed during rollback; keep the recovery hold.",
                      ),
                  });
                else yield* fs.remove(filename);
              }
              if (claim.branch)
                yield* git(claim.checkoutPath, [
                  "update-ref",
                  `refs/heads/${claim.branch}`,
                  backup.head,
                  head,
                ]);
              else
                yield* git(claim.checkoutPath, [
                  "update-ref",
                  "--no-deref",
                  "HEAD",
                  backup.head,
                  head,
                ]);
              const gitDir = yield* fs.realPath(
                yield* gitText(claim.checkoutPath, ["rev-parse", "--absolute-git-dir"]),
              );
              yield* fs.copyFile(path.join(backupDirectory, "index"), path.join(gitDir, "index"));
              yield* materializeWorkspaceFiles(backup.files, backupDirectory, claim.checkoutPath);
              if (
                !NodeUtil.isDeepStrictEqual(
                  (yield* scanWorkspaceFiles(claim.checkoutPath)).files,
                  backup.files,
                ) ||
                (yield* gitText(claim.checkoutPath, ["write-tree"])) !== backup.indexTree
              )
                return yield* workspaceFailure("The original checkout is not yet fully restored.");
              yield* flushWorkspace(claim.checkoutPath, backup);
            }
          }
          if (!exists) {
            const registrations = (yield* gitText(claim.repositoryRoot, [
              "worktree",
              "list",
              "--porcelain",
            ])).split("\n");
            if (registrations.includes(`worktree ${claim.checkoutPath}`))
              return yield* workspaceFailure(
                "The absent worktree still has Git metadata to reconcile.",
              );
            yield* sql`UPDATE thread_checkout_claims SET phase = 'rolling-back' WHERE operation_id = ${input.operationId}
            AND phase IN ('installed', 'installing', 'rolling-back')`;
          }
          if (claim.mode === "worktree" && claim.branch) {
            const branch = yield* git(
              claim.repositoryRoot,
              ["rev-parse", "--verify", "--quiet", `refs/heads/${claim.branch}`],
              { allowFailure: true },
            );
            if (branch.code === 0)
              yield* git(claim.repositoryRoot, [
                "update-ref",
                "-d",
                `refs/heads/${claim.branch}`,
                input.workspace.head,
              ]);
            else if (branch.code !== 1)
              return yield* workspaceFailure("Cannot confirm the move's branch cleanup.");
          }
          yield* sql`UPDATE thread_checkout_claims SET phase = 'released', release_reason = 'cancelled' WHERE operation_id = ${input.operationId} AND phase = 'rolling-back'`;
        }).pipe(
          Effect.ensuring(
            verifiedRoot
              ? fs.remove(verifiedRoot, { recursive: true }).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
      }),
    );
  });
  return { install, reconcile, rollback };
}
