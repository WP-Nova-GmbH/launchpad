import type { ProviderDriverKind, ProviderSendTurnInput, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderAdapterValidationError } from "./Errors.ts";

/** Check the live adapter state, after acquiring its admission lock. Legacy
 * control responses intentionally retain their existing busy/idle behavior. */
export const validateTurnDelivery = (
  provider: ProviderDriverKind,
  input: ProviderSendTurnInput,
  activeTurnId: TurnId | undefined,
) => {
  const delivery = input.delivery;
  if (!delivery) return Effect.void;
  const issue =
    delivery.mode === "steer"
      ? delivery.expectedTurnId === undefined || activeTurnId !== delivery.expectedTurnId
        ? "The target turn is no longer running. The prompt remains queued."
        : undefined
      : activeTurnId !== undefined
        ? "A turn is already running. The prompt remains queued."
        : undefined;
  return issue
    ? Effect.fail(new ProviderAdapterValidationError({ provider, operation: "sendTurn", issue }))
    : Effect.void;
};
