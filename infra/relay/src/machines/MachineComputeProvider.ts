import type { RelayMachineComputeKind, RelayMachineRole } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * Everything a driver needs to boot compute that can enroll itself: where the
 * relay is, and the single-use seed that proves the machine is the one this
 * call created (ADR-0002). The seed is injected into the instance and exists
 * nowhere else — the relay keeps only its hash.
 */
export interface MachineComputeCreateInput {
  readonly machineId: string;
  readonly organizationId: string;
  readonly role: RelayMachineRole;
  readonly label: string;
  readonly relayUrl: string;
  readonly seed: string;
}

export interface MachineComputeCreateResult {
  readonly computeKind: RelayMachineComputeKind;
  readonly computeRef: string;
}

export class MachineComputeNotConfigured extends Schema.TaggedErrorClass<MachineComputeNotConfigured>()(
  "MachineComputeNotConfigured",
  {
    machineId: Schema.String,
  },
) {
  override get message(): string {
    return `No machine compute driver is configured; machine '${this.machineId}' cannot be created`;
  }
}

export class MachineComputeRequestFailed extends Schema.TaggedErrorClass<MachineComputeRequestFailed>()(
  "MachineComputeRequestFailed",
  {
    operation: Schema.Literals(["create", "destroy"]),
    computeKind: Schema.String,
    machineId: Schema.optionalKey(Schema.String),
    computeRef: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Machine compute '${this.operation}' failed on the '${this.computeKind}' driver`;
  }
}

export type MachineComputeError = MachineComputeNotConfigured | MachineComputeRequestFailed;

/**
 * The seam between machine records and the infrastructure that runs them.
 * Production binds the Hetzner Cloud API; the dev relay binds a Docker driver
 * that runs the executor as a container on the host.
 */
export class MachineComputeProvider extends Context.Service<
  MachineComputeProvider,
  {
    /** Which driver this deployment binds; recorded on every machine it creates. */
    readonly kind: RelayMachineComputeKind;
    readonly create: (
      input: MachineComputeCreateInput,
    ) => Effect.Effect<MachineComputeCreateResult, MachineComputeError>;
    /** Destroys the compute. A ref that no longer exists is success, not failure. */
    readonly destroy: (input: {
      readonly computeKind: RelayMachineComputeKind;
      readonly computeRef: string;
    }) => Effect.Effect<void, MachineComputeError>;
  }
>()("t3code-relay/machines/MachineComputeProvider") {}

/**
 * A deployment without a compute driver refuses to provision rather than
 * pretending. Destroys succeed so deprovisioning a record whose compute is
 * long gone stays possible.
 */
export const layerUnavailable = Layer.succeed(
  MachineComputeProvider,
  MachineComputeProvider.of({
    // Arbitrary: no machine row survives a driver that refuses every create.
    kind: "docker",
    create: (input) => Effect.fail(new MachineComputeNotConfigured({ machineId: input.machineId })),
    destroy: () => Effect.void,
  }),
);
