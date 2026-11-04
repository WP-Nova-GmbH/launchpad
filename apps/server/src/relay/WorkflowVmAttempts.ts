import type { WorkflowVmDispatchBinding } from "@t3tools/contracts/workflows";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import { layer as serverSecretStoreLayer } from "../auth/ServerSecretStore.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";

export interface WorkflowVmAttemptEnvironment {
  readonly environment: Readonly<Record<string, string>>;
  readonly hasSecrets: boolean;
  readonly secretNames: ReadonlyArray<string>;
}

export function workflowReviewSecretMatcher(values: ReadonlyArray<string>) {
  const lines = [...new Set(values.flatMap((value) => value.split(/\r\n|\r|\n/u)).filter(Boolean))];
  return (text: string) => lines.some((line) => text.includes(line));
}

export const CurrentWorkflowVmAttemptEnvironment =
  Context.Reference<WorkflowVmAttemptEnvironment | null>(
    "t3/relay/CurrentWorkflowVmAttemptEnvironment",
    { defaultValue: () => null },
  );

class WorkflowVmAttemptError extends Schema.TaggedError<WorkflowVmAttemptError>()(
  "WorkflowVmAttemptError",
  {},
) {
  override get message() {
    return "This workflow's frozen environment could not be authorized for the current attempt.";
  }
}

export class WorkflowVmAttempts extends Context.Reference<{
  readonly resolve: (
    binding: WorkflowVmDispatchBinding,
    input: {
      readonly purpose: "setup" | "agent";
      readonly attemptId: string;
      readonly commandId: string;
      readonly stepId: string;
      readonly stepGeneration: number;
    },
  ) => Effect.Effect<WorkflowVmAttemptEnvironment, WorkflowVmAttemptError>;
  readonly readReviewSecrets: (
    binding: WorkflowVmDispatchBinding,
  ) => Effect.Effect<Redacted.Redacted<ReadonlyArray<string>>, WorkflowVmAttemptError>;
}>("t3/relay/WorkflowVmAttempts", {
  defaultValue: () => ({
    resolve: () => Effect.fail(new WorkflowVmAttemptError()),
    readReviewSecrets: () => Effect.fail(new WorkflowVmAttemptError()),
  }),
}) {
  static readonly layer = Layer.effect(
    WorkflowVmAttempts,
    Effect.gen(function* () {
      const vm = yield* readInstalledThreadVm();
      const url = vm && normalizeSecureRelayUrl(vm.relayUrl);
      const issuer = vm && normalizeSecureRelayUrl(vm.relayIssuer);
      const client =
        vm && url && issuer
          ? yield* makeExecutorRelayApiClient({
              url,
              issuer,
              environmentCredential: vm.environmentCredential,
            })
          : null;
      const boundClient = (binding: WorkflowVmDispatchBinding) =>
        client &&
        vm &&
        vm.environmentId === binding.environmentId &&
        vm.scope.allocationId === binding.allocationId &&
        vm.scope.threadId === binding.threadId &&
        vm.scope.repositoryId === binding.repositoryId &&
        vm.scope.generation === binding.generation &&
        vm.operationId === binding.operationId
          ? Effect.succeed(client.threadEnvironment)
          : Effect.fail(new WorkflowVmAttemptError());
      return WorkflowVmAttempts.of({
        resolve: Effect.fnUntraced(function* (binding, input) {
          const environment = yield* boundClient(binding);
          const configuration = yield* environment
            .resolveWorkflowVmAttempt({
              params: { environmentId: binding.environmentId, threadId: binding.threadId },
              payload: { ...input, jobId: binding.jobId, generation: binding.generation },
            })
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.mapError(() => new WorkflowVmAttemptError()),
            );
          if (
            configuration.hasSecrets !== configuration.secretNames.length > 0 ||
            configuration.secretNames.some(
              (name) => !Object.hasOwn(configuration.environment, name),
            )
          )
            return yield* new WorkflowVmAttemptError();
          return configuration;
        }),
        readReviewSecrets: Effect.fnUntraced(function* (binding) {
          const environment = yield* boundClient(binding);
          return yield* environment
            .readWorkflowVmReviewSecrets({
              params: { environmentId: binding.environmentId, threadId: binding.threadId },
              payload: { jobId: binding.jobId, generation: binding.generation },
            })
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.mapError(() => new WorkflowVmAttemptError()),
            );
        }),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(serverSecretStoreLayer));
}
