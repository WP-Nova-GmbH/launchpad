import type {
  RelayCodexVmConnection,
  RelayThreadVmCodexAuthSource,
  RelayThreadVmProviderAuthBinding,
} from "@t3tools/contracts/relay";

export type ThreadVmProviderAuthDialogView = {
  phase: "choose" | "saving" | "sign_in" | "checking" | "connected" | "attention" | "changed";
  source: RelayThreadVmCodexAuthSource | null;
  connection: RelayCodexVmConnection | null;
  binding: RelayThreadVmProviderAuthBinding | null;
  canManage: boolean;
  error: string | null;
};

export type ThreadVmProviderAuthDialogEvidence = {
  binding: RelayThreadVmProviderAuthBinding;
  source: RelayThreadVmCodexAuthSource | null;
  connection: RelayCodexVmConnection | null;
  selectionRevision: number;
  attempt: number | null;
  verified: boolean;
};

export type ThreadVmProviderAuthDialogInput = {
  binding: RelayThreadVmProviderAuthBinding | null;
  bindingCurrent?: boolean;
  source: RelayThreadVmCodexAuthSource | null;
  connection: RelayCodexVmConnection | null;
  sourceKnown: boolean;
  connectionKnown: boolean;
  auth: {
    requirement: "sign_in_required" | "authenticated" | "provider_unavailable";
    source: RelayThreadVmCodexAuthSource | null;
    message: string | null;
  } | null;
  selectionPhase: "idle" | "saving" | "confirmed" | "unknown" | "rejected";
  selectionRevision: number;
  accountSelectionRequired: boolean;
  attempt: number | null;
  canManage: boolean;
  error: string | null;
  completed: boolean;
};

const sameBinding = (a: RelayThreadVmProviderAuthBinding, b: RelayThreadVmProviderAuthBinding) =>
  a.operationId === b.operationId &&
  a.allocationId === b.allocationId &&
  a.environmentId === b.environmentId &&
  a.generation === b.generation &&
  a.instanceId === b.instanceId;

const sameSource = (
  a: RelayThreadVmCodexAuthSource | null,
  b: RelayThreadVmCodexAuthSource | null,
) =>
  a !== null &&
  b !== null &&
  a.mode === b.mode &&
  (a.mode === "personal" || (b.mode === "organization" && a.connectionId === b.connectionId));

/** Display evidence contains account metadata only; challenges remain in the fenced live auth read. */
export function deriveThreadVmProviderAuthDialog(
  input: ThreadVmProviderAuthDialogInput,
  previous: ThreadVmProviderAuthDialogEvidence | null = null,
): { view: ThreadVmProviderAuthDialogView; evidence: ThreadVmProviderAuthDialogEvidence | null } {
  const same =
    previous !== null &&
    (input.binding === null ? input.completed : sameBinding(previous.binding, input.binding)) &&
    previous.selectionRevision === input.selectionRevision &&
    (input.attempt === null || input.attempt === previous.attempt);
  const retained = same ? previous : null;
  const source = input.accountSelectionRequired
    ? null
    : input.sourceKnown
      ? input.source
      : (input.auth?.source ?? retained?.source ?? null);
  const sourceUnchanged = retained !== null && sameSource(source, retained.source);
  const connection = input.connectionKnown
    ? input.connection
    : source?.mode === "organization"
      ? input.auth?.source?.mode === "organization"
        ? input.auth.source.connection
        : sourceUnchanged
          ? retained.connection
          : source.connection
      : null;
  const binding = input.binding ?? (input.completed ? retained?.binding : null) ?? null;
  const usable =
    source?.mode === "personal" ||
    (source?.mode === "organization" &&
      connection?.connectionId === source.connectionId &&
      connection.status === "connected" &&
      !connection.revocationUnconfirmed);
  const evidence = binding
    ? {
        binding,
        source,
        connection,
        selectionRevision: input.selectionRevision,
        attempt: input.attempt ?? retained?.attempt ?? null,
        verified: false,
      }
    : null;
  const result = (phase: ThreadVmProviderAuthDialogView["phase"], error = input.error) => ({
    view: { phase, source, connection, binding, canManage: input.canManage, error },
    evidence,
  });
  if (!binding)
    return {
      view: {
        phase: "changed",
        source: null,
        connection: null,
        binding: null,
        canManage: false,
        error: input.error,
      },
      evidence: null,
    };
  if (input.error || input.selectionPhase === "unknown" || input.selectionPhase === "rejected")
    return result("attention");
  if (input.bindingCurrent === false) return result("checking");
  if (input.selectionPhase === "saving") return result("saving");
  if (input.accountSelectionRequired || !source)
    return result(input.canManage ? "choose" : "checking");
  if (source.mode === "organization" && input.connectionKnown && !usable)
    return result(
      "attention",
      "The organization account changed or needs to reconnect. Choose an account to continue.",
    );
  if (input.auth?.requirement === "provider_unavailable")
    return result(
      "attention",
      input.auth.message ?? "Codex is unavailable in this VM. Check its status and try again.",
    );
  if (input.auth?.requirement === "sign_in_required")
    return result(source.mode === "personal" && input.canManage ? "sign_in" : "checking");
  if (input.auth?.source && !sameSource(input.auth.source, source)) return result("checking");
  const authenticated =
    input.auth?.requirement === "authenticated" && sameSource(input.auth.source, source);
  const verified =
    usable &&
    (authenticated ||
      (input.completed && sourceUnchanged) ||
      (retained?.verified === true && sourceUnchanged));
  if (verified)
    return { ...result("connected"), evidence: evidence ? { ...evidence, verified: true } : null };
  return result("checking");
}
