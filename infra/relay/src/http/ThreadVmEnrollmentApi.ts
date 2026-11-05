import { ThreadId } from "@t3tools/contracts";
import { normalizeThreadTransferFormats } from "@t3tools/shared/threadTransferEncoding";
import {
  RelayApi,
  RelayAuthInvalidError,
  RelayThreadVmEnrollProofPayload,
  RelayThreadVmEnrollResponse,
} from "@t3tools/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_THREAD_VM_ENROLL_PROOF_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { currentTraceId } from "../observability.ts";
import { makeThreadVmAllocationStore } from "../threads/ThreadVmAllocationStore.ts";
import { makeThreadVmBindingStore } from "../threads/ThreadVmBindingStore.ts";
import {
  makeThreadVmEnrollmentStore,
  ThreadVmEnrollmentInvalid,
} from "../threads/ThreadVmEnrollmentStore.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadOwnerAccess } from "./privateThreadAccess.ts";
import { withPreparingWorkflowVm } from "../threads/ThreadVmWorkflowAccess.ts";

const invalid = () => new ThreadVmEnrollmentInvalid();
const decodeProof = Schema.decodeUnknownEffect(RelayThreadVmEnrollProofPayload);
const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmEnrollResponse));
const decodeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayThreadVmEnrollResponse),
);

export const enrollThreadVm = Effect.fn("relay.api.thread_vm.enroll")(
  function* (proof: string) {
    const config = yield* RelayConfiguration;
    const credentials = yield* EnvironmentCredentials;
    const sql = (yield* RelayDb).$client;
    const relayIssuer = normalizeRelayIssuer(config.relayIssuer);
    // Never attach token-bearing decoder errors to telemetry or the HTTP response.
    const candidate = yield* Effect.try({ try: () => decodeRelayJwt(proof), catch: invalid }).pipe(
      Effect.flatMap(decodeProof),
      Effect.mapError(invalid),
    );
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const verified = yield* verifyRelayJwt({
      publicKey: candidate.environmentPublicKey,
      token: proof,
      typ: RELAY_THREAD_VM_ENROLL_PROOF_TYP,
      issuer: `t3-env:${candidate.environmentId}`,
      audience: relayIssuer,
      nowEpochSeconds: now,
    }).pipe(Effect.flatMap(decodeProof), Effect.mapError(invalid));
    if (
      verified.sub !== verified.environmentId ||
      verified.exp <= now ||
      verified.iat > now ||
      verified.exp - verified.iat > 300
    )
      return yield* invalid();
    const allocation = yield* makeThreadVmAllocationStore(sql).getAny(verified.allocationId);
    if (!allocation) return yield* invalid();
    const input = {
      ...verified,
      seed: Redacted.make(verified.seed),
      resourceKind: allocation.resourceKind,
    };
    const exchange = (workflowConnectionId?: string) =>
      makeThreadVmEnrollmentStore(sql).exchange(
        input,
        Effect.gen(function* () {
          const environmentCredential = yield* credentials.create(input);
          const credentialId = environmentCredential.split("_")[1];
          if (!credentialId) return yield* invalid();
          const scope = yield* makeThreadVmBindingStore(sql).bind({
            ...input,
            credentialId,
            ...(workflowConnectionId ? { workflowConnectionId } : {}),
          });
          const response = {
            environmentId: input.environmentId,
            threadTransferFormats: normalizeThreadTransferFormats(input.threadTransferFormats),
            scope: { ...scope, threadId: ThreadId.make(scope.threadId) },
            relayIssuer,
            cloudMintPublicKey: config.cloudMintPublicKey,
            environmentCredential,
          };
          return {
            credentialId,
            response: Redacted.make(yield* encodeResponse(response).pipe(Effect.mapError(invalid))),
          };
        }),
      );
    const response = yield* allocation.resourceKind === "organization_workflow"
      ? withPreparingWorkflowVm(sql, input, (scope) => exchange(scope.codexConnectionId))
      : withPrivateThreadOwnerAccess(allocation.threadId, "read", allocation.ownerUserId, () =>
          exchange(),
        );
    return yield* decodeResponse(Redacted.value(response)).pipe(Effect.mapError(invalid));
  },
  Effect.catchTags({
    ThreadVmEnrollmentInvalid: () => denied(),
    ThreadVmProvisionConflict: () => denied(),
    RelayTenancyNotFoundError: () => denied(),
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    EnvironmentCredentialCreatePersistenceError: () =>
      relayInternalErrorResponse("persistence_failed"),
    PlatformError: () => relayInternalErrorResponse("internal_error"),
    SecretBoxError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
const denied = Effect.fnUntraced(function* () {
  return yield* new RelayAuthInvalidError({
    code: "auth_invalid",
    reason: "not_authorized",
    traceId: yield* currentTraceId,
  });
});

export const threadVmEnrollmentApi = HttpApiBuilder.group(
  RelayApi,
  "threadVmEnrollment",
  (handlers) => handlers.handle("enroll", ({ payload }) => enrollThreadVm(payload.proof)),
);
