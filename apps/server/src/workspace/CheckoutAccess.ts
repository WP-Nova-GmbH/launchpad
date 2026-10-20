import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class CheckoutReservedError extends Schema.TaggedError<CheckoutReservedError>()(
  "CheckoutReservedError",
  { message: Schema.String },
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

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const within = (root: string, candidate: string) =>
    candidate === root ||
    candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  const canonical = Effect.fnUntraced(function* (requested: string) {
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
  const assertAvailable = Effect.fn("CheckoutAccess.assertAvailable")(
    function* (input: { readonly path: string; readonly repository?: boolean }) {
      const held = yield* sql<{ root: string; projectId: string }>`
      SELECT c.checkout_path AS root, COALESCE(p.project_id, c.project_id) AS "projectId"
      FROM thread_checkout_claims c LEFT JOIN thread_checkout_claim_projects p USING(operation_id) WHERE c.phase <> 'released'
      UNION SELECT COALESCE(t.worktree_path, p.workspace_root) AS root, t.project_id AS "projectId"
        FROM thread_execution_fences f JOIN projection_threads t USING(thread_id)
        JOIN projection_projects p ON p.project_id = t.project_id
        WHERE f.phase = 'frozen' AND t.deleted_at IS NULL`;
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
          JOIN projection_projects p ON p.project_id=t.project_id WHERE f.phase='frozen' AND t.deleted_at IS NULL`;
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
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const candidates: string[] = [];
          for (const requested of input.paths) {
            yield* assertAvailable({ path: requested, repository: input.kind === "vcs" });
            candidates.push(yield* canonical(requested));
          }
          const projects = yield* sql<{ projectId: string; root: string }>`
          SELECT project_id AS "projectId", workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL
          UNION SELECT project_id AS "projectId", worktree_path AS root FROM projection_threads
            WHERE worktree_path IS NOT NULL AND deleted_at IS NULL`;
          const ids = new Set<string>();
          for (const project of projects) {
            // Unavailable unrelated mounts are not part of this operation.
            const root = yield* canonical(project.root).pipe(Effect.orElseSucceed(() => null));
            if (
              root &&
              candidates.some((candidate) => within(root, candidate) || within(candidate, root))
            )
              ids.add(project.projectId);
          }
          const operationId = NodeCrypto.randomUUID();
          yield* sql`INSERT INTO checkout_operations (operation_id, kind) VALUES (${operationId}, ${input.kind})`;
          for (const candidate of new Set(candidates))
            yield* sql`INSERT INTO checkout_operation_paths (operation_id, path) VALUES (${operationId}, ${candidate})`;
          for (const projectId of ids)
            yield* sql`INSERT INTO checkout_operation_projects (operation_id, project_id) VALUES (${operationId}, ${projectId})`;
          return operationId;
        }),
      );
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
