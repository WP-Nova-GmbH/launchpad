// @effect-diagnostics nodeBuiltinImport:off - Pure native path normalization and deterministic admission IDs.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const CheckoutAdmission = Context.Reference<string | undefined>("t3/CheckoutAdmission", {
  defaultValue: () => undefined,
});
export class CheckoutCaptureError extends Schema.TaggedError<CheckoutCaptureError>()(
  "CheckoutCaptureError",
  { message: Schema.String, waitingForCheckout: Schema.Boolean },
) {}
export interface CheckoutCaptureOwner {
  readonly operationId: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly generation: number;
}
export interface CheckoutCaptureScope {
  readonly checkoutRoot: string;
  readonly gitCommonRoot: string;
}
export interface CheckoutCaptureHold extends CheckoutCaptureOwner, CheckoutCaptureScope {
  readonly admissionSequence: number;
  readonly phase: "draining" | "capturing" | "released";
  readonly releaseOutcome: "sealed" | "failed" | "cancelled" | null;
  readonly manifestSha256: string | null;
}
export interface CheckoutWorkAdmission extends CheckoutCaptureScope {
  readonly sequence: number;
  readonly admissionId: string;
  readonly threadId: string;
  readonly workId: string;
  readonly kind: "provider" | "terminal" | "setup" | "workspace" | "vcs" | "write-file";
  readonly parentAdmissionId: string | null;
  readonly lineageSequence: number;
  readonly turnId: string | null;
  readonly turnFinalized: number;
  readonly completed: number;
  readonly rejected: number;
}
const fail = (message: string, waitingForCheckout = false) =>
  new CheckoutCaptureError({ message, waitingForCheckout });
const normalized = (scope: CheckoutCaptureScope) => ({
  checkoutRoot: NodePath.resolve(scope.checkoutRoot),
  gitCommonRoot: NodePath.resolve(scope.gitCommonRoot),
});
const within = (root: string, path: string) =>
  path === root || path.startsWith(root.endsWith(NodePath.sep) ? root : root + NodePath.sep);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

/** Inputs are already canonicalized by admission callers outside SQL transactions. */
export function makeCheckoutCapture(sql: SqlClient.SqlClient) {
  const holdFields = sql`operation_id AS "operationId",thread_id AS "threadId",
    environment_id AS "environmentId",generation,checkout_root AS "checkoutRoot",git_common_root AS "gitCommonRoot",
    admission_sequence AS "admissionSequence",phase,release_outcome AS "releaseOutcome",manifest_sha256 AS "manifestSha256"`;
  const active = sql<CheckoutCaptureHold>`SELECT ${holdFields} FROM checkout_capture_holds WHERE phase!='released' ORDER BY operation_id`;
  const get = (operationId: string) =>
    Effect.map(
      sql<CheckoutCaptureHold>`SELECT ${holdFields} FROM checkout_capture_holds WHERE operation_id=${operationId}`,
      (rows) => rows[0] ?? null,
    );
  const admissionFields = sql`sequence,admission_id AS "admissionId",thread_id AS "threadId",
    work_id AS "workId",kind,checkout_root AS "checkoutRoot",git_common_root AS "gitCommonRoot",
    parent_admission_id AS "parentAdmissionId",lineage_sequence AS "lineageSequence",turn_id AS "turnId",turn_finalized AS "turnFinalized",completed,rejected`;
  const admissionId = (input: Pick<CheckoutWorkAdmission, "threadId" | "kind" | "workId">) =>
    NodeCrypto.createHash("sha256")
      .update(JSON.stringify([input.threadId, input.kind, input.workId]))
      .digest("hex");
  const getAdmission = (id: string) =>
    Effect.map(
      sql<CheckoutWorkAdmission>`SELECT ${admissionFields} FROM checkout_work_admissions WHERE admission_id=${id}`,
      (rows) => rows[0] ?? null,
    );
  const lookupAdmission = (threadId: string, workId: string, kind: CheckoutWorkAdmission["kind"]) =>
    getAdmission(admissionId({ threadId, workId, kind }));
  const owned = Effect.fnUntraced(function* (owner: CheckoutCaptureOwner) {
    const row = yield* get(owner.operationId);
    if (
      !row ||
      row.threadId !== owner.threadId ||
      row.environmentId !== owner.environmentId ||
      row.generation !== owner.generation
    )
      return yield* fail("The checkout capture belongs to another move.");
    return row;
  });
  const acquireDrain = Effect.fn("CheckoutCapture.acquireDrain")(function* (
    input: CheckoutCaptureOwner & CheckoutCaptureScope,
  ) {
    const scope = normalized(input);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior = yield* get(input.operationId);
        if (prior) {
          yield* owned(input);
          if (
            prior.checkoutRoot !== scope.checkoutRoot ||
            prior.gitCommonRoot !== scope.gitCommonRoot
          )
            return yield* fail("The source checkout changed during this move.");
          if (prior.phase !== "released" || prior.releaseOutcome === "sealed") return prior;
          if (prior.releaseOutcome !== "failed")
            return yield* fail("This checkout capture was cancelled.");
        }
        if (
          (yield* active).some(
            (row) =>
              row.operationId !== input.operationId &&
              overlaps(row.checkoutRoot, scope.checkoutRoot),
          )
        )
          return yield* fail("Another move is capturing this checkout.", true);
        const [last] = yield* sql<{
          sequence: number;
        }>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM checkout_work_admissions`;
        if (prior) {
          yield* sql`UPDATE checkout_capture_holds SET phase='draining',release_outcome=NULL,manifest_sha256=NULL,
          admission_sequence=${last!.sequence} WHERE operation_id=${input.operationId}`;
        } else {
          yield* sql`INSERT INTO checkout_capture_holds
          (operation_id,thread_id,environment_id,generation,checkout_root,git_common_root,admission_sequence,phase)
          VALUES(${input.operationId},${input.threadId},${input.environmentId},${input.generation},${scope.checkoutRoot},${scope.gitCommonRoot},${last!.sequence},'draining')`;
        }
        return (yield* get(input.operationId))!;
      }),
    );
  });
  const assertAccepting = Effect.fn("CheckoutCapture.assertAccepting")(function* (
    input: CheckoutCaptureScope,
    options?: { readonly repository?: boolean; readonly parentAdmissionId?: string },
  ) {
    const scope = normalized(input);
    const parent = options?.parentAdmissionId
      ? yield* getAdmission(options.parentAdmissionId)
      : null;
    if (
      options?.parentAdmissionId &&
      (!parent || parent.completed || !within(parent.checkoutRoot, scope.checkoutRoot))
    )
      return yield* fail("The inherited checkout admission is no longer active.");
    for (const hold of yield* active) {
      const sameCheckout = overlaps(hold.checkoutRoot, scope.checkoutRoot);
      const sharedGit =
        options?.repository &&
        hold.phase === "capturing" &&
        hold.gitCommonRoot === scope.gitCommonRoot;
      if (!sameCheckout && !sharedGit) continue;
      if (
        sameCheckout &&
        hold.phase === "draining" &&
        parent &&
        parent.lineageSequence <= hold.admissionSequence
      )
        continue;
      return yield* fail("Waiting for this checkout's move snapshot to finish.", true);
    }
  });
  const admit = Effect.fn("CheckoutCapture.admit")(function* (
    input: Pick<CheckoutWorkAdmission, "threadId" | "workId" | "kind" | "checkoutRoot"> & {
      readonly gitCommonRoot?: string;
      readonly parentAdmissionId?: string;
    },
  ) {
    const scope = normalized({
      ...input,
      gitCommonRoot: input.gitCommonRoot ?? input.checkoutRoot,
    });
    const id = admissionId(input);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior = yield* getAdmission(id);
        if (prior) {
          if (
            prior.checkoutRoot !== scope.checkoutRoot ||
            prior.gitCommonRoot !== scope.gitCommonRoot ||
            prior.parentAdmissionId !== (input.parentAdmissionId ?? null)
          )
            return yield* fail("This work identity belongs to another checkout admission.");
          if (!prior.rejected)
            return {
              admissionId: id,
              decision: prior.completed ? ("completed" as const) : ("reconcile" as const),
              retrying: false,
            };
        }
        yield* assertAccepting(scope, {
          repository: input.kind === "vcs",
          ...(input.parentAdmissionId ? { parentAdmissionId: input.parentAdmissionId } : {}),
        });
        const parent = input.parentAdmissionId
          ? yield* getAdmission(input.parentAdmissionId)
          : null;
        if (parent && parent.threadId !== input.threadId)
          return yield* fail("The inherited admission belongs to another thread.");
        if (prior) {
          yield* sql`UPDATE checkout_work_admissions SET completed=0,rejected=0 WHERE admission_id=${id}`;
          return { admissionId: id, decision: "start" as const, retrying: true };
        }
        yield* sql`INSERT INTO checkout_work_admissions
        (admission_id,thread_id,work_id,kind,checkout_root,git_common_root,parent_admission_id,lineage_sequence)
        VALUES(${id},${input.threadId},${input.workId},${input.kind},${scope.checkoutRoot},${scope.gitCommonRoot},${input.parentAdmissionId ?? null},${parent?.lineageSequence ?? 0})`;
        if (!parent)
          yield* sql`UPDATE checkout_work_admissions SET lineage_sequence=sequence WHERE admission_id=${id}`;
        return { admissionId: id, decision: "start" as const, retrying: false };
      }),
    );
  });
  const complete = (id: string) =>
    sql`UPDATE checkout_work_admissions SET completed=1 WHERE admission_id=${id}`.pipe(
      Effect.asVoid,
    );
  const completeUnboundRequest = (id: string) =>
    sql`UPDATE checkout_work_admissions SET completed=1
      WHERE admission_id=${id} AND kind='provider' AND work_id LIKE 'request:%'
        AND turn_id IS NULL AND completed=0`.pipe(Effect.asVoid);
  const reject = (id: string) =>
    sql`UPDATE checkout_work_admissions SET completed=1,rejected=1
      WHERE admission_id=${id} AND kind='provider' AND turn_id IS NULL AND completed=0`.pipe(
      Effect.asVoid,
    );
  const blockers = (input: CheckoutCaptureScope) => {
    const scope = normalized(input);
    return Effect.map(
      sql<CheckoutWorkAdmission>`SELECT ${admissionFields} FROM checkout_work_admissions WHERE completed=0 ORDER BY sequence`,
      (rows) =>
        rows.filter(
          (row) =>
            overlaps(row.checkoutRoot, scope.checkoutRoot) ||
            (row.kind === "vcs" && row.gitCommonRoot === scope.gitCommonRoot),
        ),
    );
  };
  const enterCapturing = Effect.fn("CheckoutCapture.enterCapturing")(function* (
    owner: CheckoutCaptureOwner,
    options?: { readonly additionalBlockers?: ReadonlyArray<string> },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* owned(owner);
        if (row.phase === "released")
          return yield* fail("This capture has already released its checkout.");
        if (options?.additionalBlockers?.length || (yield* blockers(row)).length)
          return yield* fail("Waiting for admitted checkout work to finish.", true);
        const operations = yield* sql<{
          path: string | null;
          kind: string;
        }>`SELECT p.path,o.kind FROM checkout_operations o LEFT JOIN checkout_operation_paths p USING(operation_id)`;
        if (
          operations.some(
            ({ path, kind }) =>
              path === null ||
              overlaps(path, row.checkoutRoot) ||
              (kind === "vcs" && overlaps(path, row.gitCommonRoot)),
          )
        )
          return yield* fail("Waiting for checkout operations to finish.", true);
        if (
          (yield* active).some(
            (hold) =>
              hold.operationId !== owner.operationId &&
              hold.phase === "capturing" &&
              hold.gitCommonRoot === row.gitCommonRoot,
          )
        )
          return yield* fail("Another capture is reading this repository's Git metadata.", true);
        yield* sql`UPDATE checkout_capture_holds SET phase='capturing' WHERE operation_id=${owner.operationId}`;
        return (yield* get(owner.operationId))!;
      }),
    );
  });
  const release = Effect.fn("CheckoutCapture.release")(function* (
    owner: CheckoutCaptureOwner,
    result:
      | { readonly outcome: "sealed"; readonly manifestSha256: string }
      | {
          readonly outcome: "failed" | "cancelled";
          readonly expectedPhase?: "draining" | "capturing";
        },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* owned(owner);
        const digest = result.outcome === "sealed" ? result.manifestSha256 : null;
        if (row.phase === "released") {
          if (row.releaseOutcome !== result.outcome || row.manifestSha256 !== digest)
            return yield* fail("The capture release outcome changed.");
          return row;
        }
        if (result.outcome !== "sealed" && row.phase !== (result.expectedPhase ?? "draining"))
          return yield* fail("The checkout capture phase changed before release.");
        if (
          result.outcome === "sealed" &&
          (row.phase !== "capturing" || !/^[0-9a-f]{64}$/u.test(result.manifestSha256))
        )
          return yield* fail("A verified capture manifest is required before release.");
        yield* sql`UPDATE checkout_capture_holds SET phase='released',release_outcome=${result.outcome},manifest_sha256=${digest} WHERE operation_id=${owner.operationId}`;
        return (yield* get(owner.operationId))!;
      }),
    );
  });
  const bindTurn = Effect.fn("CheckoutCapture.bindTurn")(function* (id: string, turnId: string) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const admitted = yield* getAdmission(id);
        if (!admitted || admitted.kind !== "provider" || admitted.completed)
          return yield* fail("This provider admission cannot be bound to the turn.");
        const ancestors = sql`WITH RECURSIVE ancestors(admission_id,parent_admission_id) AS (
          SELECT admission_id,parent_admission_id FROM checkout_work_admissions WHERE admission_id=${id}
          UNION
          SELECT a.admission_id,a.parent_admission_id FROM checkout_work_admissions a
          JOIN ancestors parent ON a.admission_id=parent.parent_admission_id
        )`;
        const rows = yield* sql<{
          turnId: string | null;
        }>`${ancestors} SELECT turn_id AS "turnId" FROM checkout_work_admissions
        WHERE admission_id IN (SELECT admission_id FROM ancestors) AND kind='provider'`;
        if (rows.some((row) => row.turnId !== null && row.turnId !== turnId))
          return yield* fail("The provider admission already belongs to another turn.");
        const finalized = yield* sql`SELECT 1 FROM checkout_work_admissions
          WHERE thread_id=${admitted.threadId} AND turn_id=${turnId} AND turn_finalized=1 LIMIT 1`;
        // A steer may acknowledge after its target turn finished checkpointing.
        // bindTurn is positive native evidence; unrelated unbound calls stay live.
        yield* sql`${ancestors} UPDATE checkout_work_admissions SET turn_id=${turnId},turn_finalized=${finalized.length > 0 ? 1 : 0},completed=${finalized.length > 0 ? 1 : 0}
        WHERE admission_id IN (SELECT admission_id FROM ancestors) AND kind='provider' AND completed=0`;
      }),
    );
  });
  const completeTurn = (threadId: string, turnId: string) =>
    sql`UPDATE checkout_work_admissions SET completed=1,turn_finalized=1 WHERE thread_id=${threadId} AND kind='provider' AND turn_id=${turnId}`.pipe(
      Effect.asVoid,
    );
  const activeAdmission = (threadId: string, turnId?: string) =>
    Effect.map(
      sql<{
        admissionId: string;
      }>`SELECT admission_id AS "admissionId" FROM checkout_work_admissions
      WHERE thread_id=${threadId} AND kind='provider' AND completed=0 AND (${turnId ?? null} IS NULL OR turn_id=${turnId ?? null}) ORDER BY sequence LIMIT 1`,
      (rows) => rows[0]?.admissionId,
    );
  return {
    get,
    active,
    acquireDrain,
    enterCapturing,
    release,
    admit,
    complete,
    completeUnboundRequest,
    reject,
    blockers,
    assertAccepting,
    admissionId,
    getAdmission,
    lookupAdmission,
    bindTurn,
    completeTurn,
    activeAdmission,
  };
}
