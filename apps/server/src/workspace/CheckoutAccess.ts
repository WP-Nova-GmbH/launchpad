import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CheckoutAdmission, makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";

export class CheckoutReservedError extends Schema.TaggedError<CheckoutReservedError>()(
  "CheckoutReservedError",
  { message: Schema.String, retryable: Schema.optional(Schema.Boolean) },
) {}
export class CheckoutAccess extends Context.Service<
  CheckoutAccess,
  {
    readonly projectRegistrationPath: (
      requested: string,
    ) => Effect.Effect<string, CheckoutReservedError>;
    readonly begin: (input: {
      readonly paths: ReadonlyArray<string>;
      readonly kind: "vcs" | "write-file";
    }) => Effect.Effect<string, CheckoutReservedError>;
    readonly complete: (operationId: string) => Effect.Effect<void, CheckoutReservedError>;
    readonly assertAvailable: (input: {
      readonly path: string;
      readonly repository?: boolean;
    }) => Effect.Effect<void, CheckoutReservedError>;
  }
>()("t3/workspace/CheckoutAccess") {}

export const resolveCheckoutPath = Effect.fnUntraced(function* (
  requested: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  let parent = path.resolve(requested);
  const suffix: string[] = [];
  while (!(yield* fs.exists(parent))) {
    const next = path.dirname(parent);
    if (next === parent) break;
    suffix.unshift(path.basename(parent));
    parent = next;
  }
  return path.join(yield* fs.realPath(parent), ...suffix);
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const captures = makeCheckoutCapture(sql);
  const within = (root: string, candidate: string) =>
    candidate === root ||
    candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  const canonical = (requested: string) => resolveCheckoutPath(requested, fs, path);
  const assertAvailable = Effect.fn("CheckoutAccess.assertAvailable")(
    function* (input: { readonly path: string; readonly repository?: boolean }) {
      const held = yield* sql<{ root: string; projectId: string }>`
      SELECT c.checkout_path AS root, COALESCE(p.project_id, c.project_id) AS "projectId"
      FROM thread_checkout_claims c LEFT JOIN thread_checkout_claim_projects p USING(operation_id) WHERE c.phase <> 'released'
      UNION SELECT COALESCE(t.worktree_path, p.workspace_root) AS root, t.project_id AS "projectId"
        FROM thread_execution_fences f JOIN projection_threads t USING(thread_id)
        JOIN projection_projects p ON p.project_id = t.project_id
        WHERE f.phase = 'frozen' AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM checkout_capture_holds h
            WHERE h.operation_id=f.operation_id AND h.thread_id=f.thread_id
              AND h.generation=f.generation AND h.phase='released')`;
      // Ordinary environments do not pay for filesystem resolution.
      if (!held.length) return;
      const candidate = yield* canonical(input.path);
      const roots = held.map((row) => row.root);
      if (input.repository) {
        // Worktrees share refs and Git metadata with the main checkout. A Git
        // operation in a sibling worktree can therefore change the reserved tree.
        const related = yield* sql<{
          root: string;
        }>`SELECT p.workspace_root AS root FROM projection_projects p
        WHERE p.project_id IN ${sql.in(held.map((row) => row.projectId))}
        UNION SELECT t.worktree_path AS root FROM projection_threads t
        WHERE t.project_id IN ${sql.in(held.map((row) => row.projectId))} AND t.worktree_path IS NOT NULL`;
        roots.push(...related.map((row) => row.root));
      }
      for (const root of roots) {
        const resolved = yield* canonical(root);
        if (within(resolved, candidate) || within(candidate, resolved))
          return yield* new CheckoutReservedError({
            message:
              "A thread move has reserved this checkout. Wait for the move to finish or cancel it.",
          });
      }
    },
    Effect.mapError((error) =>
      error._tag === "CheckoutReservedError"
        ? error
        : new CheckoutReservedError({ message: "Checkout availability could not be verified." }),
    ),
  );
  // Read shared Git metadata without spawning another checkout operation in
  // the admission transaction. Linked worktrees can be absent from projections.
  const gitCommonDirectory = Effect.fnUntraced(function* (requested: string) {
    let directory = yield* canonical(requested);
    if ((yield* fs.exists(directory)) && (yield* fs.stat(directory)).type !== "Directory")
      directory = path.dirname(directory);
    while (true) {
      const marker = path.join(directory, ".git");
      let gitDirectory: string | null = null;
      if (yield* fs.exists(marker)) {
        const resolved = yield* fs.realPath(marker);
        const info = yield* fs.stat(resolved);
        if (info.type === "Directory") gitDirectory = resolved;
        else if (info.type === "File") {
          const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(yield* fs.readFileString(resolved));
          if (pointer) gitDirectory = yield* fs.realPath(path.resolve(directory, pointer[1]!));
        }
        if (gitDirectory === null)
          return yield* new CheckoutReservedError({
            message: "Shared Git metadata could not be verified.",
          });
      } else if (
        (yield* fs.exists(path.join(directory, "HEAD"))) &&
        (yield* fs.exists(path.join(directory, "objects"))) &&
        (yield* fs.exists(path.join(directory, "refs")))
      ) {
        gitDirectory = directory;
      }
      if (gitDirectory !== null) {
        const common = path.join(gitDirectory, "commondir");
        if (!(yield* fs.exists(common))) return gitDirectory;
        const target = (yield* fs.readFileString(common)).trim();
        if (!target || /[\r\n]/.test(target))
          return yield* new CheckoutReservedError({
            message: "Shared Git metadata could not be verified.",
          });
        return yield* fs.realPath(path.resolve(gitDirectory, target));
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  });
  const projectRegistrationPath = Effect.fn("CheckoutAccess.projectRegistrationPath")(
    function* (requested: string) {
      const candidate = yield* canonical(requested);
      yield* assertAvailable({ path: candidate, repository: true });
      // Registration can add another alias of shared Git metadata while an old
      // operation is uncertain. Include its known main and sibling worktrees.
      const related = yield* sql<{ root: string | null }>`
        SELECT p.workspace_root AS root FROM checkout_operation_projects x
        JOIN checkout_operations o USING(operation_id)
        LEFT JOIN projection_projects p USING(project_id)
        UNION SELECT t.worktree_path AS root FROM checkout_operation_projects x
        JOIN checkout_operations o USING(operation_id)
        JOIN projection_threads t USING(project_id) WHERE t.worktree_path IS NOT NULL`;
      for (const { root } of related) {
        if (root === null)
          return yield* new CheckoutReservedError({
            message: "Finish checkout operations before changing project registrations.",
          });
        const resolved = yield* canonical(root);
        if (within(resolved, candidate) || within(candidate, resolved))
          return yield* new CheckoutReservedError({
            message: "Finish checkout operations before changing project registrations.",
          });
      }
      const gitRoots = yield* sql<{ path: string; recordedVcs: number }>`
        SELECT DISTINCT p.path,CASE WHEN o.kind='vcs' THEN 1 ELSE 0 END AS "recordedVcs"
        FROM checkout_operations o JOIN checkout_operation_paths p USING(operation_id)
        UNION SELECT repository_root AS path,0 AS "recordedVcs" FROM thread_checkout_claims WHERE phase<>'released'
        UNION SELECT checkout_path AS path,0 AS "recordedVcs" FROM thread_checkout_claims WHERE phase<>'released'
        UNION SELECT COALESCE(t.worktree_path,p.workspace_root) AS path,0 AS "recordedVcs"
          FROM thread_execution_fences f JOIN projection_threads t USING(thread_id)
          JOIN projection_projects p ON p.project_id=t.project_id WHERE f.phase='frozen' AND t.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM checkout_capture_holds h
              WHERE h.operation_id=f.operation_id AND h.thread_id=f.thread_id
                AND h.generation=f.generation AND h.phase='released')`;
      if (gitRoots.length) {
        const common = yield* gitCommonDirectory(candidate);
        if (common !== null)
          for (const held of gitRoots) {
            if (held.recordedVcs && !(yield* fs.exists(held.path)))
              return yield* new CheckoutReservedError({
                message: "Shared Git metadata could not be verified.",
              });
            const pending = yield* gitCommonDirectory(held.path);
            if (pending !== null && (within(common, pending) || within(pending, common)))
              return yield* new CheckoutReservedError({
                message: "Finish checkout operations before changing project registrations.",
              });
          }
      }
      return candidate;
    },
    Effect.mapError((error) =>
      error._tag === "CheckoutReservedError"
        ? error
        : new CheckoutReservedError({
            message: "Project checkout path could not be verified.",
          }),
    ),
  );
  // The record is committed before entering the operation. Only observed completion
  // removes it: interruption, lost process replies and restart retain the hold.
  const begin = Effect.fn("CheckoutAccess.begin")(
    function* (input: {
      readonly paths: ReadonlyArray<string>;
      readonly kind: "vcs" | "write-file";
    }) {
      if (!input.paths.length)
        return yield* new CheckoutReservedError({ message: "A checkout operation needs a path." });
      const readInputs = Effect.gen(function* () {
        const held = yield* sql<{ root: string; projectId: string }>`
          SELECT c.checkout_path AS root, COALESCE(p.project_id,c.project_id) AS "projectId"
          FROM thread_checkout_claims c LEFT JOIN thread_checkout_claim_projects p USING(operation_id)
          WHERE c.phase <> 'released'
          UNION SELECT COALESCE(t.worktree_path,p.workspace_root) AS root,t.project_id AS "projectId"
          FROM thread_execution_fences f JOIN projection_threads t USING(thread_id)
          JOIN projection_projects p ON p.project_id=t.project_id
          WHERE f.phase='frozen' AND t.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM checkout_capture_holds h
              WHERE h.operation_id=f.operation_id AND h.thread_id=f.thread_id
                AND h.generation=f.generation AND h.phase='released') ORDER BY "projectId",root`;
        const related =
          input.kind === "vcs" && held.length > 0
            ? yield* sql<{ root: string }>`
                SELECT workspace_root AS root FROM projection_projects
                WHERE project_id IN ${sql.in(held.map((row) => row.projectId))}
                UNION SELECT worktree_path AS root FROM projection_threads
                WHERE project_id IN ${sql.in(held.map((row) => row.projectId))}
                  AND worktree_path IS NOT NULL ORDER BY root`
            : [];
        const projects = yield* sql<{ projectId: string; root: string }>`
          SELECT project_id AS "projectId", workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL
          UNION SELECT project_id AS "projectId", worktree_path AS root FROM projection_threads
            WHERE worktree_path IS NOT NULL AND deleted_at IS NULL ORDER BY "projectId",root`;
        return { held, related, projects };
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        const inputs = yield* readInputs;
        const candidates = yield* Effect.forEach(input.paths, canonical);
        const commonRoots =
          input.kind === "vcs" ? yield* Effect.forEach(input.paths, gitCommonDirectory) : [];
        const parentAdmissionId = yield* CheckoutAdmission;
        const protectedRoots = yield* Effect.forEach([...inputs.held, ...inputs.related], (row) =>
          canonical(row.root),
        );
        const projects = yield* Effect.forEach(inputs.projects, (project) =>
          canonical(project.root).pipe(
            // Unavailable unrelated mounts are not part of this operation.
            Effect.orElseSucceed(() => null),
            Effect.map((root) => ({ projectId: project.projectId, root })),
          ),
        );
        const admitted = yield* sql.withTransaction(
          Effect.gen(function* () {
            if (!NodeUtil.isDeepStrictEqual(yield* readInputs, inputs)) return null;
            const parent = parentAdmissionId
              ? yield* captures.getAdmission(parentAdmissionId)
              : null;
            for (let index = 0; index < candidates.length; index++) {
              yield* captures
                .assertAccepting(
                  {
                    checkoutRoot: candidates[index]!,
                    gitCommonRoot: commonRoots[index] ?? candidates[index]!,
                  },
                  {
                    repository: input.kind === "vcs",
                    ...(parent && within(parent.checkoutRoot, candidates[index]!)
                      ? { parentAdmissionId: parent.admissionId }
                      : {}),
                  },
                )
                .pipe(
                  Effect.catchTag("CheckoutCaptureError", (error) =>
                    Effect.fail(
                      new CheckoutReservedError({
                        message: error.message,
                        retryable: error.waitingForCheckout,
                      }),
                    ),
                  ),
                );
            }
            for (const candidate of candidates)
              if (protectedRoots.some((root) => within(root, candidate) || within(candidate, root)))
                return yield* new CheckoutReservedError({
                  message:
                    "A thread move has reserved this checkout. Wait for the move to finish or cancel it.",
                });
            const ids = new Set<string>();
            for (const { projectId, root } of projects)
              if (
                root !== null &&
                candidates.some((candidate) => within(root, candidate) || within(candidate, root))
              )
                ids.add(projectId);
            const operationId = NodeCrypto.randomUUID();
            yield* sql`INSERT INTO checkout_operations (operation_id, kind) VALUES (${operationId}, ${input.kind})`;
            for (const candidate of new Set(candidates))
              yield* sql`INSERT INTO checkout_operation_paths (operation_id, path) VALUES (${operationId}, ${candidate})`;
            for (const common of new Set(commonRoots))
              if (common !== null && !candidates.includes(common))
                yield* sql`INSERT INTO checkout_operation_paths (operation_id, path) VALUES (${operationId}, ${common})`;
            for (const projectId of ids)
              yield* sql`INSERT INTO checkout_operation_projects (operation_id, project_id) VALUES (${operationId}, ${projectId})`;
            return operationId;
          }),
        );
        if (admitted !== null) return admitted;
      }
      return yield* new CheckoutReservedError({
        message: "Checkout paths or reservations changed while preparing the operation. Retry it.",
        retryable: true,
      });
    },
    Effect.mapError((error) =>
      error._tag === "CheckoutReservedError"
        ? error
        : new CheckoutReservedError({ message: "Checkout operation could not be registered." }),
    ),
  );
  const complete = Effect.fn("CheckoutAccess.complete")(
    function* (operationId: string) {
      yield* sql`DELETE FROM checkout_operations WHERE operation_id = ${operationId}`;
    },
    Effect.mapError(
      () =>
        new CheckoutReservedError({
          message: "Checkout operation completion could not be recorded.",
        }),
    ),
  );
  return CheckoutAccess.of({ assertAvailable, begin, complete, projectRegistrationPath });
});
export const layer = Layer.effect(CheckoutAccess, make);
