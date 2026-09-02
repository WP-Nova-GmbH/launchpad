import {
  RelayApi,
  RelayInternalError,
  RelayProviderAccountPayload,
  type RelayExecutorProviderAccount,
  type RelayProviderAccount,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as RelaySecretBox from "../auth/SecretBox.ts";
import * as ProviderAccounts from "../tenancy/ProviderAccounts.ts";
import { mapErrorTags, mapRelayCommonApiErrors } from "./Api.ts";
import { requireEnrolledExecutor } from "./enrolledExecutor.ts";

const encodePayloadJson = Schema.encodeEffect(Schema.fromJsonString(RelayProviderAccountPayload));
const decodePayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayProviderAccountPayload),
);

export class ProviderAccountPayloadUnreadable extends Schema.TaggedErrorClass<ProviderAccountPayloadUnreadable>()(
  "ProviderAccountPayloadUnreadable",
  { provider: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Provider account payload for '${this.provider}' could not be opened`;
  }
}

/** The payload as it goes into the row: JSON, then sealed. */
export const sealProviderAccountPayload = Effect.fn("relay.provider_accounts.seal")(function* (
  payload: RelayProviderAccountPayload,
) {
  const secretBox = yield* RelaySecretBox.RelaySecretBox;
  const json = yield* encodePayloadJson(payload);
  return yield* secretBox.seal(json);
});

/** The row's payload, opened and decoded; unreadable rows fail rather than degrade. */
export const openProviderAccountPayload = Effect.fn("relay.provider_accounts.open")(function* (
  record: ProviderAccounts.ProviderAccountRecord,
) {
  const secretBox = yield* RelaySecretBox.RelaySecretBox;
  return yield* secretBox.open(record.payloadSealed).pipe(
    Effect.flatMap(decodePayloadJson),
    Effect.mapError(
      (cause) => new ProviderAccountPayloadUnreadable({ provider: record.provider, cause }),
    ),
  );
});

export function toApiProviderAccount(
  record: ProviderAccounts.ProviderAccountRecord,
): RelayProviderAccount {
  return {
    provider: record.provider,
    kind: record.kind,
    label: record.label,
    version: record.version,
    updatedByUserId: record.updatedByUserId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Every account the organization holds, opened for the executor that asked. */
export const openProviderAccountsForExecutor = Effect.fn(
  "relay.provider_accounts.open_for_executor",
)(function* (input: { readonly environmentId: string }) {
  const machine = yield* requireEnrolledExecutor({ environmentId: input.environmentId });
  const accounts = yield* ProviderAccounts.ProviderAccounts;
  const records = yield* accounts.listForOrganization({
    organizationId: machine.organizationId,
  });
  const opened: Array<RelayExecutorProviderAccount> = [];
  for (const record of records) {
    opened.push({
      provider: record.provider,
      label: record.label,
      version: record.version,
      payload: yield* openProviderAccountPayload(record),
    });
  }
  return { machine, accounts: opened };
});

/**
 * Provider accounts for managed executors (ADR-0003, organization provider
 * accounts). An enrolled agent executor receives the organization's accounts
 * with their secrets opened; the relay keeps nothing about the request.
 */
export const providerAccountsServerApi = HttpApiBuilder.group(
  RelayApi,
  "providerAccountsServer",
  (handlers) =>
    handlers.handle(
      "fetchProviderAccounts",
      Effect.fn("relay.api.provider_accounts.fetch")(
        function* (args) {
          const { machine, accounts } = yield* openProviderAccountsForExecutor({
            environmentId: args.params.environmentId,
          });
          yield* Effect.logInfo("provider accounts delivered to executor", {
            organizationId: machine.organizationId,
            machineId: machine.machineId,
            providers: accounts.map((account) => account.provider),
          });
          return { accounts };
        },
        mapErrorTags({
          ProviderAccountPayloadUnreadable: (_error, traceId) =>
            new RelayInternalError({ code: "internal_error", reason: "internal_error", traceId }),
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    ),
);
