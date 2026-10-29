/** Historical database evidence only. These types do not authorize native VM operations. */
interface ColdProbeReceipt {
  readonly version: 1;
  readonly preparedBuildID: string;
  readonly rootfsSHA256: string;
  readonly initSHA256: string;
  readonly physicalStopConfirmed: true;
  readonly mountOnly: true;
}
export interface E2BBackupColdProof {
  readonly operationID: string;
  readonly generation: string;
  readonly preparedBuildID: string;
  readonly manifestSHA256: string;
  readonly coldProbe: ColdProbeReceipt;
}
export interface E2BRestoreStatus {
  readonly coldProbe?: ColdProbeReceipt;
  readonly operationID: string;
  readonly generation: string;
  readonly sandboxID: string;
  readonly executionID: string;
  readonly preparedBuildID: string;
  readonly state:
    | "preparing"
    | "prepared"
    | "activating"
    | "active"
    | "cancelling"
    | "cancelled"
    | "failed";
  readonly manifestSHA256?: string;
  readonly error?: string | null;
}
export interface E2BExecutionRetentionCandidate {
  readonly sandboxID: string;
  readonly executionID: string;
  readonly buildID: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly disposition: "ready_tip" | "no_current_tip";
}
