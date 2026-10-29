import { CodexVmConnectionError, RelayThreadVmProviderAuthRequest } from "@t3tools/contracts/relay";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { makeE2BThreadVmProviderAuth } from "../machines/E2BThreadVmProviderAuth.ts";
import { readPendingThreadVmProviderAuth } from "../threads/ThreadVmPendingProviderAuth.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyConflict } from "./tenancyErrors.ts";
import { makeThreadVmCodexAuthStore } from "../threads/ThreadVmCodexAuthStore.ts";
import { codexVmConnectionMetadata } from "./CodexVmConnectionsApi.ts";

/** Guest status reenters the relay for its source. Never retain placement locks over that call. */
export const threadVmProviderAuth = Effect.fn("relay.api.thread_vm.provider_auth")(
  function* (
    threadId: string,
    action: "status" | "start" | "cancel",
    input?: RelayThreadVmProviderAuthRequest & { flowId?: string },
  ) {
    const sql = (yield* RelayDb).$client;
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    const authorize = withPrivateThreadAccess(
      threadId,
      action === "status" ? "read" : "write",
      (placement) =>
        Effect.gen(function* () {
          const pending = yield* readPendingThreadVmProviderAuth(sql, threadId);
          if (!pending && action === "status") return null;
          if (
            !pending ||
            (action !== "status" &&
              (!input ||
                input.operationId !== pending.binding.operationId ||
                input.allocationId !== pending.binding.allocationId ||
                input.generation !== pending.binding.generation))
          )
            return yield* tenancyConflict("thread_placement_changed");
          const source = yield* makeThreadVmCodexAuthStore(sql).connection({
            ...pending.binding,
            threadId,
            organizationId: placement.organizationId,
          });
          return { pending, source };
        }),
    );
    const before = yield* authorize;
    if (!before) return null;
    if (before.source.selection.mode === "organization" && action !== "status")
      return {
        ...before.pending.binding,
        requirement: "provider_unavailable" as const,
        authSource: {
          ...before.source.selection,
          connection: codexVmConnectionMetadata(
            before.source.connection,
            (yield* DateTime.now).epochMilliseconds,
          ),
        },
        auth: {
          instanceId: ProviderInstanceId.make("codex"),
          phase: "failed" as const,
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          methods: [],
          credentialOwner: "t3" as const,
          message: new CodexVmConnectionError({ reason: "organization_managed" }).message,
        },
      };
    if (!settings) return yield* tenancyConflict("thread_placement_changed");
    const result = yield* makeE2BThreadVmProviderAuth(settings.compute)({
      ...before.pending,
      threadId,
      control: {
        binding: before.pending.binding,
        action,
        ...(input?.flowId ? { flowId: input.flowId } : {}),
      },
    }).pipe(Effect.timeout("45 seconds"));
    const after = yield* authorize;
    const previous = before.pending;
    if (
      !after ||
      after.pending.binding.operationId !== previous.binding.operationId ||
      after.pending.binding.allocationId !== previous.binding.allocationId ||
      after.pending.computeRef !== previous.computeRef ||
      after.pending.binding.generation !== previous.binding.generation ||
      after.pending.binding.environmentId !== previous.binding.environmentId ||
      after.source.selection.mode !== before.source.selection.mode ||
      (after.source.selection.mode === "organization" &&
        (before.source.selection.mode !== "organization" ||
          after.source.selection.connectionId !== before.source.selection.connectionId))
    )
      return yield* tenancyConflict("thread_placement_changed");
    if (after.source.selection.mode === "organization") {
      const connection = codexVmConnectionMetadata(
        after.source.connection,
        (yield* DateTime.now).epochMilliseconds,
      );
      const supported =
        result.authSource?.mode === "organization" &&
        result.authSource.connectionId === after.source.selection.connectionId;
      if (!supported || connection.status !== "connected")
        return {
          ...result,
          requirement: "provider_unavailable" as const,
          authSource: { ...after.source.selection, connection },
          auth: {
            instanceId: ProviderInstanceId.make("codex"),
            phase: "failed" as const,
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            methods: [],
            credentialOwner: "t3" as const,
            message: !supported
              ? "This VM cannot use organization Codex. Update the VM or select personal sign-in."
              : "Reconnect the organization's Codex account in Organization settings.",
          },
        };
      return { ...result, authSource: { ...after.source.selection, connection } };
    }
    return { ...result, authSource: after.source.selection };
  },
  Effect.catchTags({
    ThreadVmComputeError: () => relayInternalErrorResponse("upstream_unavailable"),
    TimeoutError: () => relayInternalErrorResponse("upstream_unavailable"),
  }),
);
