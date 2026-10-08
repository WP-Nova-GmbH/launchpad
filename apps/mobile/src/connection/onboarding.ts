import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairingUrl = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-pairing-url",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { pairingUrl: string; clientLabel?: string }) => JSON.stringify(input),
  },
  execute: (input: { pairingUrl: string; clientLabel?: string }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerPairing(input))),
});

export const updateBearerConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-bearer",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) => ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.updateBearer(input))),
});

export const readConnectedClient = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:read-client",
  execute: (environmentId: EnvironmentId) =>
    ConnectionOnboarding.pipe(Effect.flatMap((service) => service.currentSession(environmentId))),
});
export const renameConnectedClient = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:rename-client",
  execute: (input: { environmentId: EnvironmentId; label: string }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((service) => service.renameClient(input))),
});
