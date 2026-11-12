import { describe, expect, layer } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { DEFAULT_THREAD_VM_POLICY, RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RelayDb } from "../db.ts";
import * as Organizations from "../tenancy/Organizations.ts";
import {
  getThreadVmPolicy,
  updateThreadVmPolicy,
  getWorkflowVmPolicy,
  updateWorkflowVmPolicy,
} from "./ThreadVmPolicyApi.ts";

const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;
const migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!databaseUrl || !/^\/launchpad_vm_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname))
      return yield* Effect.die("Tests require a dedicated launchpad_vm_test_* database");
    const db = yield* PgDrizzle.makeWithDefaults();
    yield* migrate(db, {
      migrationsFolder: new URL("../../migrations/postgres/", import.meta.url).pathname,
      migrationsTable: "relay_migrations",
    });
  }),
).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl ?? ""), maxConnections: 5 })),
);
const services = Organizations.layer.pipe(
  Layer.provideMerge(
    Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(Layer.provideMerge(migrated)),
  ),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provide(NodeServices.layer),
);
const fixture = Effect.fnUntraced(function* () {
  const crypto = yield* Crypto.Crypto;
  const organizationId = yield* crypto.randomUUIDv4;
  const adminId = yield* crypto.randomUUIDv4;
  const memberId = yield* crypto.randomUUIDv4;
  const organizations = yield* Organizations.Organizations;
  yield* organizations.ensureForUser({ organizationId, userId: adminId });
  yield* organizations.addMember({ organizationId, userId: memberId, role: "member" });
  return { organizationId, adminId, memberId };
});
const asUser = (userId: string) =>
  Effect.provideService(RelayClientPrincipal, { userId, token: "test" });

describe.skipIf(!databaseUrl)("organization workflow VM policy (Postgres)", () => {
  layer(services)((it) => {
    it.effect("defaults to ten, allows member reads, and restricts writes to current admins", () =>
      Effect.gen(function* () {
        const { organizationId, adminId, memberId } = yield* fixture();
        const initial = yield* getWorkflowVmPolicy().pipe(asUser(memberId));
        expect(initial).toEqual({ organizationId, revision: 1, maxRunningVms: 10 });
        expect(
          yield* Effect.flip(
            updateWorkflowVmPolicy({ ...initial, maxRunningVms: 0 }).pipe(asUser(memberId)),
          ),
        ).toMatchObject({ _tag: "RelayTenancyForbiddenError", reason: "not_an_admin" });
        const saved = yield* updateWorkflowVmPolicy({ ...initial, maxRunningVms: 0 }).pipe(
          asUser(adminId),
        );
        expect(saved).toEqual({ ...initial, revision: 2, maxRunningVms: 0 });
        expect(
          yield* Effect.flip(updateWorkflowVmPolicy(initial).pipe(asUser(adminId))),
        ).toMatchObject({ _tag: "RelayTenancyConflictError", reason: "vm_policy_changed" });
        const outsider = yield* fixture();
        expect(
          yield* Effect.flip(updateWorkflowVmPolicy(saved).pipe(asUser(outsider.adminId))),
        ).toMatchObject({ _tag: "RelayTenancyConflictError", reason: "vm_policy_changed" });
        expect(yield* getWorkflowVmPolicy().pipe(asUser(adminId))).toEqual(saved);
      }),
    );

    it.effect("keeps both policy values and revisions independent in either save order", () =>
      Effect.gen(function* () {
        const { adminId } = yield* fixture();
        const personal = yield* getThreadVmPolicy().pipe(asUser(adminId));
        const workflow = yield* getWorkflowVmPolicy().pipe(asUser(adminId));
        const changedPersonal = {
          ...personal,
          policy: { ...DEFAULT_THREAD_VM_POLICY, maxVmsPerUser: 7 },
        };
        const firstWorkflow = yield* updateWorkflowVmPolicy({ ...workflow, maxRunningVms: 4 }).pipe(
          asUser(adminId),
        );
        const firstPersonal = yield* updateThreadVmPolicy(changedPersonal).pipe(asUser(adminId));
        expect(yield* getWorkflowVmPolicy().pipe(asUser(adminId))).toEqual(firstWorkflow);
        const secondPersonal = yield* updateThreadVmPolicy({
          ...firstPersonal,
          policy: { ...firstPersonal.policy, maxVmsPerUser: 8 },
        }).pipe(asUser(adminId));
        const secondWorkflow = yield* updateWorkflowVmPolicy({
          ...firstWorkflow,
          maxRunningVms: 6,
        }).pipe(asUser(adminId));
        expect(yield* getThreadVmPolicy().pipe(asUser(adminId))).toEqual(secondPersonal);
        const [concurrentPersonal, concurrentWorkflow] = yield* Effect.all(
          [
            updateThreadVmPolicy({
              ...secondPersonal,
              policy: { ...secondPersonal.policy, maxVmsPerUser: 9 },
            }).pipe(asUser(adminId)),
            updateWorkflowVmPolicy({ ...secondWorkflow, maxRunningVms: 5 }).pipe(asUser(adminId)),
          ],
          { concurrency: 2 },
        );
        expect(yield* getThreadVmPolicy().pipe(asUser(adminId))).toEqual(concurrentPersonal);
        expect(yield* getWorkflowVmPolicy().pipe(asUser(adminId))).toEqual(concurrentWorkflow);
      }),
    );

    it.effect("serializes concurrent saves using the workflow revision", () =>
      Effect.gen(function* () {
        const { adminId } = yield* fixture();
        const initial = yield* getWorkflowVmPolicy().pipe(asUser(adminId));
        const replies = yield* Effect.all(
          [2, 3].map((maxRunningVms) =>
            updateWorkflowVmPolicy({ ...initial, maxRunningVms }).pipe(
              asUser(adminId),
              Effect.result,
            ),
          ),
          { concurrency: 2 },
        );
        expect(replies.filter((entry) => entry._tag === "Success")).toHaveLength(1);
        expect(replies.filter((entry) => entry._tag === "Failure")).toHaveLength(1);
        expect((yield* getWorkflowVmPolicy().pipe(asUser(adminId))).revision).toBe(2);
      }),
    );

    it.effect("rechecks admin authority after membership resolution", () =>
      Effect.gen(function* () {
        const { adminId, organizationId } = yield* fixture();
        const initial = yield* getWorkflowVmPolicy().pipe(asUser(adminId));
        const organizations = yield* Organizations.Organizations;
        const loaded = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const saving = yield* updateWorkflowVmPolicy({ ...initial, maxRunningVms: 1 }).pipe(
          asUser(adminId),
          Effect.provideService(Organizations.Organizations, {
            ...organizations,
            getMembershipForUser: (input) =>
              organizations.getMembershipForUser(input).pipe(
                Effect.tap(() => Deferred.succeed(loaded, undefined)),
                Effect.tap(() => Deferred.await(proceed)),
              ),
          }),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(loaded);
        yield* (yield* PgClient.PgClient)`UPDATE relay_organization_members SET role='member' WHERE user_id=${adminId} AND organization_id=${organizationId}`;
        yield* Deferred.succeed(proceed, undefined);
        const reply = yield* Fiber.join(saving);
        expect(reply).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "RelayTenancyForbiddenError", reason: "not_an_admin" },
        });
        expect(yield* getWorkflowVmPolicy().pipe(asUser(adminId))).toEqual(initial);
      }),
    );
  });
});
