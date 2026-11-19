import type { DpopFailureReason } from "@t3tools/contracts";
import type { RelayProtectedError } from "@t3tools/contracts/relay";

export const DPOP_CLOCK_HINT =
  "Hint: Check that automatic date and time is enabled on both devices, then try again.";

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
export const DPOP_UNKNOWN_HINT =
  "Hint: Try again. If it still fails, clock skew may be the cause; check that automatic date and time is enabled on both devices.";

export const DPOP_RETRY_HINT = "Hint: Try again. If the problem continues, copy the trace ID.";

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return DPOP_CLOCK_HINT;
  if (reason === undefined) return DPOP_UNKNOWN_HINT;
  return DPOP_RETRY_HINT;
}

export function dpopFailureMessage(message: string, reason: DpopFailureReason | undefined): string {
  return `${message} ${dpopFailureHint(reason)}`;
}

export function relayProtectedErrorMessage(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return "Relay rejected the cloud session token.";
        case "invalid_dpop":
          return dpopFailureMessage("Relay rejected the DPoP proof.", error.dpopFailureReason);
        case "not_authorized":
          return "Relay rejected the authenticated request.";
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return "Relay rejected an expired environment link proof.";
    case "RelayEnvironmentLinkProofInvalidError":
      return `Relay rejected the environment link proof (${error.reason}).`;
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link does not read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return "Relay has no active link for this environment. The environment server may not have re-established its link yet.";
      }
      return error.reason
        ? `Relay rejected the environment connection request (${error.reason}).`
        : "Relay rejected the environment connection request.";
    case "RelayEnvironmentEndpointUnavailableError":
      return `Relay could not reach the environment endpoint (${error.reason}).`;
    case "RelayEnvironmentEndpointTimedOutError":
      return "Relay timed out while contacting the environment endpoint.";
    case "RelayEnvironmentLinkFailedError":
      return `Relay could not link the environment (${error.reason}).`;
    case "RelayEnvironmentLinkUnavailableError":
      return `Relay cannot provision the managed endpoint (${error.reason}).`;
    case "RelayEnvironmentLinkLimitExceededError":
      return `Relay refused the link: this account already has its maximum of ${error.maxTunnels} managed tunnels. Unlink an environment to free one up.`;
    case "RelayAgentActivityPublishProofExpiredError":
      return "Relay rejected an expired agent activity publish proof.";
    case "RelayAgentActivityPublishProofInvalidError":
      return `Relay rejected the agent activity publish proof (${error.reason}).`;
    case "RelayProjectCatalogPublishProofExpiredError":
      return "Relay rejected an expired project catalog publish proof.";
    case "RelayProjectCatalogPublishProofInvalidError":
      return `Relay rejected the project catalog publish proof (${error.reason}).`;
    case "RelayMachineEnrollProofInvalidError":
      return `Relay rejected the machine enrollment proof (${error.reason}).`;
    case "RelayMachineEnrollFailedError":
      return `Relay could not enroll the machine (${error.reason}).`;
    case "RelayMachineEnrollUnavailableError":
      return `Relay cannot provision the machine's managed endpoint (${error.reason}).`;
    case "RelayMachineComputeUnavailableError":
      if (error.reason === "retired")
        return "Managed machine provisioning has been replaced by thread VMs. Existing managed compute requires cleanup on its original host.";
      return error.reason === "not_configured"
        ? "Relay has no machine compute provider configured."
        : "Relay could not reach the machine compute provider.";
    case "RelayTenancyForbiddenError":
      return `Relay refused the organization change (${error.reason}).`;
    case "RelayTenancyNotFoundError":
      if (error.reason === "thread_not_found")
        return "This thread is unavailable or you no longer have access.";
      return `Relay could not find the organization record (${error.reason}).`;
    case "RelayTenancyConflictError":
      if (error.reason === "thread_deletion_conflict")
        return "Deletion cannot start while another VM operation is being confirmed. Wait for it to finish or cancel it, then retry.";
      if (error.reason === "thread_placement_changed")
        return "The thread location changed or is moving. Refresh its location before retrying.";
      if (error.reason === "thread_vm_move_required")
        return "Start a thread locally, then move it to a private VM to upload its workspace.";
      if (error.reason === "thread_command_conflict")
        return "This request conflicts with an existing thread command. Refresh the thread before retrying.";
      if (error.reason === "vm_policy_changed")
        return "VM settings changed elsewhere. Reload them before saving.";
      return `Relay refused the organization change because it conflicts with existing state (${error.reason}).`;
    case "RelayTenancyInvalidError":
      return `Relay refused the organization record as invalid (${error.reason}).`;
    case "RelayIssueTrackerError":
      return error.message;
    case "RelayInternalError":
      return `Relay encountered an internal error (${error.reason}).`;
  }
}
