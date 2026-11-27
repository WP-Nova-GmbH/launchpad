import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  deriveThreadVmProviderAuthDialog as derive,
  type ThreadVmProviderAuthDialogInput,
} from "./threadVmAccountDialog.ts";

const binding = {
  operationId: "move-1",
  allocationId: "vm-1",
  environmentId: EnvironmentId.make("environment-1"),
  generation: 2,
  instanceId: "codex",
} as const;
const connection = {
  connectionId: "organization-1",
  label: "team@example.test",
  status: "connected",
  epoch: 1,
  tokenRevision: 1,
  refreshing: false,
  errorCode: null,
} as const;
const source = { mode: "organization", connectionId: connection.connectionId, connection } as const;
const base: ThreadVmProviderAuthDialogInput = {
  binding,
  source,
  connection,
  sourceKnown: true,
  connectionKnown: true,
  auth: null,
  selectionPhase: "confirmed",
  selectionRevision: 2,
  accountSelectionRequired: false,
  attempt: 1,
  canManage: true,
  error: null,
  completed: false,
};
const authenticated: ThreadVmProviderAuthDialogInput["auth"] = {
  requirement: "authenticated",
  source,
  message: null,
};

describe("VM account dialog confirmation", () => {
  it("does not confuse an accepted account selection or worker verification with authentication", () => {
    expect(derive(base).view.phase).toBe("checking");
    expect(derive({ ...base, canManage: false }).view.phase).toBe("checking");
    expect(derive({ ...base, auth: authenticated }).view.phase).toBe("connected");
  });

  it("keeps personal sign-in interactive until the guest reports authenticated", () => {
    const personal = { mode: "personal" } as const;
    const input = {
      ...base,
      source: personal,
      connection: null,
      auth: { requirement: "sign_in_required", source: personal, message: null },
    } satisfies ThreadVmProviderAuthDialogInput;
    expect(derive(input).view.phase).toBe("sign_in");
    expect(
      derive({ ...input, auth: { ...input.auth, requirement: "authenticated" } }).view,
    ).toMatchObject({
      phase: "connected",
      source: personal,
    });
  });

  it("retains verified identity through the same attempt's fenced verification read", () => {
    const previous = derive({ ...base, auth: authenticated });
    expect(
      derive(
        {
          ...base,
          sourceKnown: false,
          connectionKnown: false,
          auth: null,
          canManage: false,
        },
        previous.evidence,
      ).view,
    ).toMatchObject({
      phase: "connected",
      source,
      binding,
      canManage: false,
    });
    expect(Object.keys(previous.evidence!)).toEqual([
      "binding",
      "source",
      "connection",
      "selectionRevision",
      "attempt",
      "verified",
    ]);
  });

  it("replaces cached success with current read failures and requires fresh proof to recover", () => {
    const previous = derive({ ...base, auth: authenticated });
    const failed = derive(
      { ...base, error: "Could not inspect Codex", canManage: false },
      previous.evidence,
    );
    expect(failed.view).toMatchObject({ phase: "attention", error: "Could not inspect Codex" });
    expect(derive(base, failed.evidence).view.phase).toBe("checking");
    expect(derive({ ...base, auth: authenticated }, failed.evidence).view.phase).toBe("connected");
  });

  it("does not retain success for a new worker attempt or selection revision", () => {
    const previous = derive({ ...base, auth: authenticated });
    expect(derive({ ...base, attempt: 2 }, previous.evidence).view.phase).toBe("checking");
    expect(derive({ ...base, selectionRevision: 3 }, previous.evidence).view.phase).toBe(
      "checking",
    );
  });

  it("keeps only candidate identity while placement and VM status are between transitions", () => {
    const previous = derive({ ...base, auth: authenticated });
    const checking = derive({ ...base, bindingCurrent: false }, previous.evidence);
    expect(checking.view.phase).toBe("checking");
    expect(checking.evidence).toMatchObject({ source, verified: false });
    expect(derive({ ...base, binding: null, completed: true }, checking.evidence).view.phase).toBe(
      "connected",
    );
  });

  it("requires authenticated source to match the chosen current account", () => {
    const previous = derive({ ...base, auth: authenticated });
    expect(
      derive({ ...base, auth: { ...authenticated, source: { mode: "personal" } } }).view.phase,
    ).toBe("checking");
    expect(
      derive(
        { ...base, auth: { ...authenticated, source: { mode: "personal" } } },
        previous.evidence,
      ).view.phase,
    ).toBe("checking");
    expect(
      derive({
        ...base,
        auth: authenticated,
        connection: { ...connection, connectionId: "replacement" },
      }).view.phase,
    ).toBe("attention");
  });

  it("invalidates success after organization revocation, disconnection or replacement", () => {
    const previous = derive({ ...base, auth: authenticated });
    for (const current of [
      { ...connection, status: "disconnected" as const },
      { ...connection, revocationUnconfirmed: true },
      { ...connection, connectionId: "replacement" },
      null,
    ])
      expect(
        derive({ ...base, auth: authenticated, connection: current }, previous.evidence).view.phase,
      ).toBe("attention");
    expect(
      derive({ ...base, accountSelectionRequired: true, source: null }, previous.evidence).view
        .phase,
    ).toBe("choose");
  });

  it("accepts exact target completion even when the authenticated GET was too fast to observe", () => {
    const selected = derive(base);
    expect(
      derive(
        { ...base, binding: null, completed: true, canManage: false, attempt: null },
        selected.evidence,
      ).view,
    ).toMatchObject({
      phase: "connected",
      source,
      binding,
      canManage: false,
    });
  });

  it("never treats disappearance, cancellation or a new binding as successful completion", () => {
    const previous = derive({ ...base, auth: authenticated });
    expect(derive({ ...base, binding: null }, previous.evidence).view).toMatchObject({
      phase: "changed",
      source: null,
      binding: null,
    });
    expect(
      derive({ ...base, binding: { ...binding, allocationId: "different" } }, previous.evidence)
        .view.phase,
    ).toBe("checking");
    expect(derive({ ...base, binding: null, completed: true }, null).view.phase).toBe("changed");
    expect(
      derive(
        { ...base, binding: null, completed: true, source: { mode: "personal" } },
        previous.evidence,
      ).view.phase,
    ).toBe("checking");
  });

  it("cannot confirm a saving, uncertain or rejected selection from a stale authenticated reply", () => {
    for (const selectionPhase of ["saving", "unknown", "rejected"] as const) {
      const result = derive({ ...base, selectionPhase, auth: authenticated });
      expect(result.view.phase).toBe(selectionPhase === "saving" ? "saving" : "attention");
      expect(result.evidence?.verified).toBe(false);
    }
  });
});
