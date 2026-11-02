import { describe, expect, it } from "@effect/vitest";
import { ThreadId, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { RelayThreadVmStatus, RelayPortableThreadPlacement } from "@t3tools/contracts/relay";
import {
  threadVmPresentation,
  threadVmStatusLabel,
  threadVmProviderAuthPresentation,
  threadVmActionUnavailableReason,
  threadMoveProgressPresentation,
  threadVmCapabilityLabel,
  threadVmWorkerAuthState,
} from "./threadVmControls.ts";

const threadId = ThreadId.make("thread");
const status: RelayThreadVmStatus = {
  threadId,
  generation: 2,
  allocation: { allocationId: "vm", ownerUserId: "owner", state: "running" },
  setupPhase: "ready",
  capacityState: "started",
  activity: "idle",
  pausePhase: null,
  resumePhase: null,
  sourceActivationPending: false,
  backupPhase: null,
  lastVerifiedBackupAt: null,
};
const repository = { canonicalKey: "github.com/owner/repo", branch: "main", revision: "commit" };
const savedDisk = {
  operationId: "saved",
  phase: "available" as const,
  savedAt: "2026-10-22T12:00:00Z",
  expiresAt: "2026-11-22T12:00:00Z",
};

describe("VM presentation uses confirmed runtime state", () => {
  it("matches worker auth to the exact pending destination and gives normal waits a neutral action", () => {
    const binding = {
      operationId: "move",
      allocationId: "vm",
      environmentId: EnvironmentId.make("next-vm"),
      generation: 3,
      instanceId: "codex" as const,
    };
    const pending = { ...status, pendingProviderAuth: binding };
    const placement: RelayPortableThreadPlacement = {
      threadId,
      environmentId: "mac",
      generation: 2,
      operationId: "move",
      projectId: "project",
      organizationId: "org",
      repositoryId: "repo",
      ownerUserId: "owner",
      moveProgress: [
        {
          threadId,
          operationId: "move",
          environmentId: "next-vm",
          generation: 3,
          participant: "destination",
          attempt: 2,
          revision: 1,
          stage: "downloading",
          completedBytes: 0,
          totalBytes: null,
          completedArtifacts: 0,
          totalArtifacts: null,
          waitingForAuth: "account_selection",
          updatedAt: "2026-10-30T00:00:00Z",
        },
      ],
    };
    expect(threadVmWorkerAuthState(placement, pending)).toBe("account_selection");
    for (const changed of [
      { ...placement, operationId: "old" },
      { ...placement, generation: 3 },
      {
        ...placement,
        moveProgress: placement.moveProgress!.map((p) => ({ ...p, environmentId: "other-vm" })),
      },
      { ...placement, moveProgress: placement.moveProgress!.map((p) => ({ ...p, generation: 4 })) },
    ])
      expect(threadVmWorkerAuthState(changed, pending)).toBeUndefined();
    expect(
      threadVmPresentation({ status: pending, workerAuth: "account_selection" }),
    ).toMatchObject({
      label: "Choose a Codex account",
      tone: "neutral",
      primary: { type: "sign_in", label: "Choose account" },
    });
    expect(threadVmPresentation({ status: pending, workerAuth: "verification" })).toMatchObject({
      label: "Checking Codex sign-in",
      tone: "neutral",
      primary: null,
    });
    expect(
      threadVmPresentation({
        status: pending,
        workerAuth: "personal_sign_in",
        providerAuth: {
          ...binding,
          requirement: "authenticated",
          auth: {
            instanceId: ProviderInstanceId.make("codex"),
            phase: "idle",
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            message: null,
            interaction: null,
          },
        },
      }),
    ).toMatchObject({ label: "Preparing VM", tone: "neutral", primary: null });
  });
  it("waits for source activation after power resume before advertising readiness", () => {
    for (const [pausePhase, backupPhase] of [
      ["cancelled", "retired"],
      ["completed", "verified"],
      [null, "failed"],
      [null, "verified"],
    ] as const) {
      const resumed = {
        ...status,
        pausePhase,
        backupPhase,
        resumePhase: "completed" as const,
        sourceActivationPending: true,
      };
      expect(threadVmPresentation({ status: resumed, queuePaused: true })).toMatchObject({
        label: "Waiting for VM",
        ready: false,
        held: true,
        canPreview: false,
        primary: null,
        detail: "The VM is running. Waiting for this conversation to reopen.",
      });
      expect(
        threadVmPresentation({
          status: { ...resumed, sourceActivationPending: false },
          queuePaused: true,
        }),
      ).toMatchObject({
        label: "VM ready · queue paused",
        ready: true,
        held: false,
        canPreview: true,
      });
    }
  });

  it("keeps Resume available for a paused source awaiting activation", () => {
    for (const pausePhase of ["completed", "cancelled"] as const) {
      expect(
        threadVmPresentation({
          status: {
            ...status,
            allocation: { ...status.allocation!, state: "paused" },
            pausePhase,
            resumePhase: "completed",
            sourceActivationPending: true,
          },
        }),
      ).toMatchObject({
        label: "VM paused",
        ready: false,
        held: false,
        canPreview: false,
        primary: { type: "resume" },
      });
    }
  });

  it("uses native restore progress and offers cancellation only when the relay admits it", () => {
    for (const phase of ["committed", "creating", "bootstrapping", "booted"] as const) {
      const restore = { operationId: "restore", phase, errorCode: null };
      expect(
        threadVmPresentation({ status: { ...status, restore: { ...restore, canCancel: true } } }),
      ).toMatchObject({
        ready: false,
        primary: { type: "cancel_restore" },
        canCancelRestore: true,
      });
      for (const canCancel of [false, undefined])
        expect(
          threadVmPresentation({
            status: {
              ...status,
              restore: { ...restore, ...(canCancel === undefined ? {} : { canCancel }) },
            },
          }),
        ).toMatchObject({ primary: null, canCancelRestore: false });
      expect(
        threadVmActionUnavailableReason(
          { type: "cancel_restore", operationId: "restore" },
          { ...status, restore: { ...restore, canCancel: false } },
        ),
      ).toContain("can no longer be cancelled");
    }
    expect(
      threadVmStatusLabel({
        ...status,
        restore: {
          operationId: "restore",
          phase: "creating",
          errorCode: null,
        },
      }),
    ).toBe("Starting replacement VM");
    expect(
      threadVmStatusLabel({
        ...status,
        restore: {
          operationId: "restore",
          phase: "bootstrapping",
          errorCode: null,
        },
      }),
    ).toBe("Preparing restored VM");
  });
  it("does not describe missing or unfinished allocations as running", () => {
    expect(threadVmStatusLabel({ ...status, allocation: null, setupPhase: null })).toBe(
      "VM status unavailable",
    );
    expect(threadVmStatusLabel({ ...status, setupPhase: null })).toBe("VM status unavailable");
    expect(threadVmPresentation({ status: null }).primary?.type).toBe("check");
    expect(
      threadVmPresentation({ status: { ...status, allocation: null, setupPhase: null } }).primary
        ?.type,
    ).toBe("check");
    expect(
      threadVmPresentation({ status, error: "Connection failed", queuePaused: true }),
    ).toMatchObject({
      label: "VM status unavailable",
      ready: false,
      canPreview: false,
      canRecoverBackup: false,
      canDelete: false,
    });
  });
  it("shows errors ahead of ordinary progress, and preparation failure has cancellation instead of retry", () => {
    const failed = threadVmPresentation({ status: { ...status, setupPhase: "failed" } });
    expect(failed.label).toBe("VM setup needs attention");
    expect(failed.tone).toBe("danger");
    expect(failed.primary?.type).toBe("cancel_setup");
    expect(
      threadVmPresentation({ status, queuePaused: true, error: "Relay disconnected" }),
    ).toMatchObject({
      label: "VM status unavailable",
      tone: "danger",
      detail: "Relay disconnected",
    });
    expect(
      threadVmStatusLabel({
        ...status,
        restore: { operationId: "restore", phase: "importing", errorCode: "failed" },
      }),
    ).toBe("VM restore needs attention");
  });
  it("offers the appropriate recovery without waking a VM for a read", () => {
    expect(
      threadVmPresentation({
        status: { ...status, allocation: { ...status.allocation!, state: "paused" } },
      }).primary?.type,
    ).toBe("resume");
    expect(
      threadVmPresentation({ status: { ...status, allocation: null, savedDisk } }).primary?.type,
    ).toBe("restore");
    expect(
      threadVmPresentation({
        status: {
          ...status,
          allocation: null,
          savedDisk: { ...savedDisk, phase: "expired" },
          repository,
        },
      }).primary?.type,
    ).toBe("reset");
    expect(
      threadVmPresentation({
        status: { ...status, allocation: null, savedDisk: { ...savedDisk, phase: "expired" } },
      }).primary,
    ).toBeNull();
    expect(threadVmPresentation({ status: { ...status, repository } }).primary).toBeNull();
  });
  it("keeps a resume request pending until confirmed and retains the queue pause", () => {
    expect(threadVmPresentation({ status: { ...status, resumePhase: "waiting" } })).toMatchObject({
      label: "Resume requested",
      ready: false,
      primary: null,
    });
    expect(threadVmPresentation({ status, queuePaused: true })).toMatchObject({
      label: "VM ready · queue paused",
      ready: true,
    });
  });
  it("allows private preview after a completed or cancelled pause, while active pause blocks it", () => {
    for (const pausePhase of [null, "completed", "cancelled"] as const)
      expect(threadVmPresentation({ status: { ...status, pausePhase } }).canPreview).toBe(true);
    for (const pausePhase of ["pending", "sealed"] as const)
      expect(threadVmPresentation({ status: { ...status, pausePhase } }).canPreview).toBe(false);
    expect(threadVmPresentation({ status, pendingRequest: true }).canPreview).toBe(false);
  });
  it("distinguishes disabled runtime features from unknown status", () => {
    expect(threadVmCapabilityLabel(null, "autoPause")).toBe("Status unknown");
    const capabilities = {
      configured: true,
      autoPause: false,
      autoBackup: false,
      autoDelete: false,
      replacement: false,
      restore: false,
      reset: false,
      permanentDelete: false,
      privatePreview: false,
    };
    expect(threadVmCapabilityLabel(capabilities, "autoPause")).toBe("Inactive");
    expect(threadVmCapabilityLabel(capabilities, "configured")).toBe("Enabled");
    expect(
      threadVmPresentation({ status: { ...status, allocation: null, savedDisk }, capabilities })
        .disabledReason,
    ).toBe("This VM action is inactive on the relay.");
  });
  it("rejects stale lifecycle generations and prevents resetting a running VM", () => {
    const reset = {
      type: "reset" as const,
      payload: { operationId: "reset", allocationId: "new", expectedGeneration: 2, ...repository },
    };
    expect(threadVmActionUnavailableReason(reset, { ...status, repository })).toBe(
      "Reset is available only after the saved workspace expires.",
    );
    expect(
      threadVmActionUnavailableReason(reset, {
        ...status,
        repository,
        savedDisk: { ...savedDisk, phase: "expired" },
      }),
    ).toBeNull();
    expect(
      threadVmActionUnavailableReason(
        { ...reset, payload: { ...reset.payload, expectedGeneration: 1 } },
        status,
      ),
    ).toContain("changed");
    expect(threadVmActionUnavailableReason({ type: "resume" }, status)).toContain(
      "no longer paused",
    );
  });
});

describe("VM sign-in expiry", () => {
  const value = {
    requirement: "sign_in_required" as const,
    auth: {
      instanceId: ProviderInstanceId.make("codex"),
      phase: "waiting" as const,
      flowId: "flow",
      authorizationUrl: "https://auth.openai.com/codex/device",
      expiresAt: "2026-10-22T12:00:00Z",
      message: null,
      interaction: {
        type: "deviceCode" as const,
        id: "code",
        url: "https://auth.openai.com/codex/device",
        userCode: "SECRET",
      },
    },
  };
  it("hides the expired code and link and restarts the existing sign-in flow", () => {
    expect(
      threadVmProviderAuthPresentation(value, Date.parse("2026-10-22T12:00:00Z")),
    ).toMatchObject({
      expired: true,
      userCode: null,
      url: null,
      canStart: true,
      canCancel: false,
      title: "Codex sign-in expired",
    });
    expect(
      threadVmProviderAuthPresentation(value, Date.parse("2026-10-22T11:59:59Z")),
    ).toMatchObject({ expired: false, userCode: "SECRET", canStart: false });
  });
  it("distinguishes an unavailable Codex runner from account sign-in and waits after authentication", () => {
    const binding = {
      operationId: "move",
      allocationId: "vm",
      environmentId: EnvironmentId.make("destination"),
      generation: 3,
      instanceId: "codex" as const,
    };
    const waiting = { ...value, ...binding };
    const pending = { ...status, pendingProviderAuth: binding };
    expect(threadVmPresentation({ status: pending, providerAuth: waiting })).toMatchObject({
      primary: { type: "sign_in", label: "Finish Codex sign-in" },
    });
    expect(
      threadVmPresentation({
        status: pending,
        providerAuth: { ...waiting, requirement: "provider_unavailable" },
      }),
    ).toMatchObject({ label: "Codex needs attention", tone: "danger", primary: { type: "check" } });
    expect(
      threadVmPresentation({
        status: pending,
        providerAuth: { ...waiting, requirement: "authenticated" },
      }),
    ).toMatchObject({ label: "Preparing VM", primary: null });
  });
  it("fails closed when no current clock was supplied", () => {
    expect(threadVmProviderAuthPresentation(value)).toMatchObject({
      expired: true,
      url: null,
      userCode: null,
    });
  });
});

describe("move transfer progress", () => {
  const placement: RelayPortableThreadPlacement = {
    threadId,
    organizationId: "org",
    repositoryId: "repo",
    ownerUserId: "owner",
    environmentId: EnvironmentId.make("source"),
    projectId: "project",
    generation: 2,
    operationId: "move",
    moveProgress: [
      {
        operationId: "move",
        threadId,
        environmentId: EnvironmentId.make("source"),
        generation: 2,
        participant: "source",
        attempt: 1,
        revision: 1,
        stage: "uploading",
        completedBytes: 1024,
        totalBytes: 2048,
        completedArtifacts: 1,
        totalArtifacts: 2,
        updatedAt: "2026-10-22T12:00:00Z",
      },
    ],
  };
  it("uses verified bytes without inventing an overall percent", () => {
    expect(threadMoveProgressPresentation(placement)).toEqual({
      label: "Uploading files",
      detail: "1 KB of 2 KB verified",
      stage: "uploading",
    });
    expect(
      threadMoveProgressPresentation({
        ...placement,
        moveProgress: placement.moveProgress!.map((progress) => ({
          ...progress,
          totalBytes: null,
        })),
      })?.detail,
    ).toBeNull();
    expect(
      threadMoveProgressPresentation({
        ...placement,
        moveProgress: placement.moveProgress!.map((progress) => ({
          ...progress,
          totalBytes: 0,
          completedBytes: 0,
        })),
      })?.detail,
    ).toBe("0 B of 0 B verified");
  });
  it("describes an exact destination auth wait instead of its synthetic download stage", () => {
    const progress = {
      ...placement.moveProgress![0]!,
      participant: "destination" as const,
      environmentId: "destination",
      generation: 3,
      stage: "downloading" as const,
      completedBytes: 0,
      totalBytes: null,
      completedArtifacts: 0,
      totalArtifacts: null,
      waitingForAuth: "account_selection" as const,
    };
    expect(
      threadMoveProgressPresentation({ ...placement, moveProgress: [progress] }),
    ).toMatchObject({
      label: "Choose a Codex account",
      detail: expect.stringContaining("Choose personal sign-in"),
    });
    expect(
      threadMoveProgressPresentation({
        ...placement,
        moveProgress: [{ ...progress, waitingForAuth: null }],
      }),
    ).toMatchObject({
      label: "Downloading files",
      detail: null,
    });
    for (const stale of [
      { ...progress, operationId: "old" },
      { ...progress, generation: 4 },
    ])
      expect(threadMoveProgressPresentation({ ...placement, moveProgress: [stale] })).toBeNull();
    expect(
      threadMoveProgressPresentation({
        ...placement,
        moveFailureDetail: "Current failure",
        moveProgress: [progress],
      }),
    ).toBeNull();
    expect(
      threadMoveProgressPresentation({
        ...placement,
        moveProgress: [{ ...placement.moveProgress![0]!, waitingForAuth: "account_selection" }],
      }),
    ).toMatchObject({ label: "Uploading files" });
  });
  it("ignores stale operation snapshots, errors, and terminal placements", () => {
    expect(threadMoveProgressPresentation({ ...placement, operationId: null })).toBeNull();
    expect(
      threadMoveProgressPresentation({ ...placement, moveFailureDetail: "Setup failed" }),
    ).toBeNull();
    expect(threadMoveProgressPresentation({ ...placement, operationId: "other" })).toBeNull();
  });
  it("keeps destination progress ahead of a late source update", () => {
    expect(
      threadMoveProgressPresentation({
        ...placement,
        moveProgress: [
          ...placement.moveProgress!,
          {
            ...placement.moveProgress![0]!,
            participant: "destination",
            generation: 3,
            environmentId: EnvironmentId.make("destination"),
            stage: "setup",
            totalBytes: null,
            revision: 1,
            updatedAt: "2026-10-22T11:59:59Z",
          },
        ],
      })?.label,
    ).toBe("Preparing project");
  });
});
