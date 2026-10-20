import { Machines } from "../machines/Machines.ts";
import { Repositories } from "../tenancy/Repositories.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { Workflows } from "./Workflows.ts";
import { deliverPendingWorkflowJobs } from "./WorkflowDispatcher.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import { AutomaticOffers } from "../workflowEvents/AutomaticOffer.ts";
import * as Wake from "./WorkflowWake.ts";

it.effect("coalesces wake bursts and periodic overlap through the same drain gate", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let scans = 0;
    const services = Layer.mergeAll(
      Layer.mock(Workflows)({
        pendingJobs: () =>
          Effect.gen(function* () {
            scans++;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return [];
          }),
      }),
      Layer.mock(EnvironmentConnector)({}),
      Layer.mock(Organizations)({}),
      Layer.mock(Machines)({}),
      Layer.mock(Repositories)({}),
      Layer.mock(OrganizationProjectCatalog)({}),
    );
    const first = yield* deliverPendingWorkflowJobs().pipe(
      Effect.provide(services),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* Effect.all(
      Array.from({ length: 20 }, () => deliverPendingWorkflowJobs()),
      { concurrency: "unbounded" },
    ).pipe(Effect.provide(services));
    expect(scans).toBe(1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* deliverPendingWorkflowJobs().pipe(Effect.provide(services));
    expect(scans).toBe(2);
  }),
);
it.effect("keeps Node wake work alive after the HTTP child scope returns", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const services = Layer.mergeAll(
      Layer.mock(Workflows)({
        pendingJobs: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            yield* Deferred.succeed(finished, undefined);
            return [];
          }),
      }),
      Layer.mock(EnvironmentConnector)({}),
      Layer.mock(Organizations)({}),
      Layer.mock(Machines)({}),
      Layer.mock(Repositories)({}),
      Layer.mock(OrganizationProjectCatalog)({}),
      Layer.mock(AutomaticOffers)({}),
    );
    yield* Effect.gen(function* () {
      yield* Effect.scoped(Wake.wakeWorkflows());
      yield* Deferred.await(entered);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finished);
    }).pipe(Effect.provide(Wake.layer.pipe(Layer.provide(services))));
  }),
);
