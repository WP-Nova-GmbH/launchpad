import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionAuthority } from "./ThreadExecutionAuthority.ts";
import { makeThreadExecutionRelay } from "./ThreadExecutionRelay.ts";

export class ThreadExecution extends Context.Service<
  ThreadExecution,
  ReturnType<typeof makeThreadExecutionRelay>
>()("t3/relay/ThreadExecution") {}

export const layer = Layer.effect(
  ThreadExecution,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const vm = yield* readInstalledThreadVm();
    return makeThreadExecutionRelay(
      sql,
      yield* makeThreadExecutionAuthority,
      vm
        ? {
            threadId: vm.scope.threadId,
            generation: vm.scope.generation,
            environmentId: vm.environmentId,
            relayUrl: vm.relayUrl,
          }
        : undefined,
    );
  }),
);
