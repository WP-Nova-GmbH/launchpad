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
