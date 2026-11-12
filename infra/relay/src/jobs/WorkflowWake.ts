import { AutomaticOffers } from "../workflowEvents/AutomaticOffer.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Alchemy from "alchemy";
import { WorkerExecutionContext } from "alchemy/Cloudflare/Workers";
import { deliverPendingWorkflowJobs } from "./WorkflowDispatcher.ts";
import type { WorkflowDispatchScope } from "./Workflows.ts";

export class WorkflowWake extends Context.Service<
  WorkflowWake,
  {
    readonly wake: (scope?: WorkflowDispatchScope) => Effect.Effect<void>;
  }
>()("launchpad-relay/jobs/WorkflowWake") {}

export const layer = Layer.effect(
  WorkflowWake,
  Effect.gen(function* () {
    const serverScope = yield* Scope.Scope;
    const context = yield* Effect.context<
      Effect.Services<ReturnType<typeof deliverPendingWorkflowJobs>> | AutomaticOffers
    >();
    return WorkflowWake.of({
      wake: Effect.fn("WorkflowWake.wake")(function* (scope) {
        const task = deliverPendingWorkflowJobs(scope).pipe(
          Effect.timeout("25 seconds"),
          Effect.ignoreCause({ log: true }),
          Effect.provide(context),
        );
        const worker = yield* Effect.serviceOption(WorkerExecutionContext);
        const runtime = yield* Effect.serviceOption(Alchemy.RuntimeContext);
        if (Option.isSome(worker) && Option.isSome(runtime))
          yield* worker.value
            .waitUntil(task)
            .pipe(Effect.provideService(Alchemy.RuntimeContext, runtime.value));
        else yield* Effect.forkIn(task, serverScope);
      }),
    });
  }),
);

/** Without a runtime wake service, persisted jobs still recover through the periodic worker. */
export const wakeWorkflows = Effect.fn("WorkflowWake.request")(function* (
  scope?: WorkflowDispatchScope,
) {
  const service = yield* Effect.serviceOption(WorkflowWake);
  if (Option.isSome(service))
    yield* service.value.wake(scope).pipe(Effect.ignoreCause({ log: true }));
});
