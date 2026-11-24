import { ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { classifyThreadVmActivity, makeE2BThreadVmActivity } from "./E2BThreadVmActivity.ts";

const empty = { bootId: "boot", sealedBy: null, stopped: true, groups: [] } as const;
const group = (kind: "provider" | "terminal" | "process" | "transfer" | "probe") => ({
  id: kind,
  bootId: "boot",
  kind,
});
const providerOnly = { ...empty, stopped: false, groups: [group("provider")] };
const idleCodex = { ...providerOnly, codexOnly: true as const };

describe("thread VM workload activity", () => {
  it("accepts only the privileged passive setup observation for workflow idleness", () => {
    const passive = { ...empty, stopped: false, groups: [group("terminal")] };
    expect(classifyThreadVmActivity(passive, true)).toBe("unknown");
    expect(classifyThreadVmActivity({ ...passive, recoverable: true }, true)).toBe("idle");
    expect(
      classifyThreadVmActivity({ ...passive, recoverable: true, sealedBy: "pause" }, true),
    ).toBe("unknown");
    expect(
      classifyThreadVmActivity(
        { ...passive, recoverable: true, groups: [group("provider")] },
        true,
      ),
    ).toBe("unknown");
    expect(
      classifyThreadVmActivity({ ...passive, recoverable: true, groups: [group("probe")] }, true),
    ).toBe("unknown");
  });
  it("treats active work as busy and unclassified terminal or inconsistent reports as unknown", () => {
    expect(classifyThreadVmActivity(empty)).toBe("idle");
    expect(
      classifyThreadVmActivity({ ...empty, stopped: false, groups: [group("provider")] }),
    ).toBe("busy");
    expect(
      classifyThreadVmActivity({ ...empty, stopped: false, groups: [group("terminal")] }),
    ).toBe("unknown");
    expect(classifyThreadVmActivity({ ...empty, sealedBy: "move" })).toBe("unknown");
    expect(classifyThreadVmActivity({ ...empty, stopped: false })).toBe("unknown");
  });

  it("accepts an attested singleton Codex process only for a finished workflow", () => {
    expect(classifyThreadVmActivity(idleCodex, true, true)).toBe("idle");
    expect(classifyThreadVmActivity(idleCodex, true)).toBe("unknown");
    expect(classifyThreadVmActivity(idleCodex, false, true)).toBe("busy");
    for (const workloads of [
      providerOnly,
      { ...idleCodex, groups: [group("terminal")] },
      { ...idleCodex, groups: [group("provider"), group("terminal")] },
      { ...idleCodex, groups: [{ ...group("provider"), bootId: "previous" }] },
      { ...idleCodex, sealedBy: "pause" },
    ]) {
      expect(classifyThreadVmActivity(workloads, true, true)).not.toBe("idle");
    }
  });

  for (const situation of [
    "idle",
    "queued-prompt",
    "queued-move",
    "archived",
    "paused-queue",
    "delivery-unknown",
    "unfinished",
    "held",
    "foreign-environment",
    "old-generation",
    "old-helper",
    "stopped-processes",
    "live-process",
    "live-probe",
    "finished-idle-codex",
    "finished-codex-with-queued-prompt",
    "finished-codex-with-unfinished-work",
    "finished-codex-with-background-work",
    "finished-codex-without-background-receipt",
    "finished-stopped-background",
    "awaiting-review-codex",
  ] as const)
    it.effect(`reads current durable VM activity without waking it (${situation})`, () =>
      Effect.gen(function* () {
        const codexOnly = situation.includes("codex");
        const finishedWorkflow = situation.startsWith("finished-");
        const backgroundRevision =
          situation === "finished-stopped-background"
            ? `${"a".repeat(32)}:stopped`
            : codexOnly && situation !== "finished-codex-without-background-receipt"
              ? "a".repeat(32)
              : undefined;
        const transport = vi.fn(
          async (_url: string, _options?: RequestInit) =>
            new Response(
              JSON.stringify({
                sandboxID: "sandbox",
                templateID: "template",
                state: "running",
                envdVersion: "1",
                envdAccessToken: "token",
                metadata: {
                  "launchpad.managed": "thread-vm-v1",
                  "launchpad.allocation_id": "allocation",
                  "launchpad.operation_id": "operation",
                  "launchpad.thread_id": "thread",
                  "launchpad.generation": "1",
                },
                lifecycle: { autoResume: false },
              }),
              { status: 200 },
            ),
        );
        const projection = {
          threadId: "thread",
          environmentId: situation === "foreign-environment" ? "foreign" : "environment",
          generation: situation === "old-generation" ? 2 : 1,
          phase: situation === "held" ? "draining" : "active",
          archived: situation === "archived",
          unfinished: ["unfinished", "finished-codex-with-unfinished-work"].includes(situation),
          ...(backgroundRevision ? { backgroundRevision } : {}),
          backgroundBusy: situation === "finished-codex-with-background-work",
          processWorkIds: codexOnly
            ? ["provider:idle"]
            : ["stopped-processes", "live-process", "live-probe"].includes(situation)
              ? ["provider:idle", "terminal:closed", "setup:ready"]
              : [],
          queue: {
            enabled: situation !== "paused-queue",
            handoff: null,
            awaitingTurnId: null,
            entries: [
              "idle",
              "unfinished",
              "held",
              "foreign-environment",
              "old-generation",
              "stopped-processes",
              "live-process",
              "live-probe",
              "finished-idle-codex",
              "finished-codex-with-unfinished-work",
              "finished-codex-with-background-work",
              "finished-codex-without-background-receipt",
              "finished-stopped-background",
              "awaiting-review-codex",
            ].includes(situation)
              ? []
              : [{ state: situation === "delivery-unknown" ? "unknown" : "pending" }],
          },
        };
        const guest = vi.fn(async () =>
          JSON.stringify(
            situation === "old-helper"
              ? empty
              : {
                  workloads: codexOnly
                    ? idleCodex
                    : situation === "live-process" || situation === "live-probe"
                      ? {
                          ...empty,
                          stopped: false,
                          groups: [group(situation === "live-probe" ? "probe" : "process")],
                        }
                      : finishedWorkflow
                        ? { ...empty, recoverable: true }
                        : empty,
                  projection,
                },
          ),
        );
        const inspect = makeE2BThreadVmActivity(
          {
            apiUrl: "http://e2b-api.test",
            sandboxUrl: "http://e2b-sandbox.test",
            apiKey: Redacted.make("test"),
            templateId: "template:build-version",
            hostAddresses: [],
            timeoutMs: 60_000,
          },
          transport as typeof fetch,
          guest,
        );
        const result = yield* Effect.result(
          inspect("sandbox", {
            environmentId: "environment",
            operationId: "operation",
            ...(codexOnly || finishedWorkflow ? { workflowCheckpoint: true } : {}),
            ...(finishedWorkflow ? { finishedWorkflow: true } : {}),
            scope: {
              allocationId: "allocation",
              threadId: ThreadId.make("thread"),
              repositoryId: RelayRepositoryId.make("repo"),
              generation: 1,
            },
          }),
        );
        if (situation === "old-helper") expect(result._tag).toBe("Failure");
        else {
          expect(result._tag).toBe("Success");
          if (
            result._tag === "Success" &&
            ["stopped-processes", "finished-idle-codex", "finished-stopped-background"].includes(
              situation,
            )
          )
            expect(result.success).toEqual({
              activity: "idle",
              inactiveWorkIds: projection.processWorkIds,
              ...(backgroundRevision ? { backgroundRevision } : {}),
            });
          else if (result._tag === "Success")
            expect(result.success).toBe(
              ["held", "foreign-environment", "old-generation", "awaiting-review-codex"].includes(
                situation,
              )
                ? "unknown"
                : [
                      "queued-prompt",
                      "queued-move",
                      "delivery-unknown",
                      "unfinished",
                      "live-process",
                      "live-probe",
                      "finished-codex-with-queued-prompt",
                      "finished-codex-with-unfinished-work",
                      "finished-codex-with-background-work",
                      "finished-codex-without-background-receipt",
                    ].includes(situation)
                  ? "busy"
                  : "idle",
            );
        }
        expect(transport).toHaveBeenCalledOnce();
        expect(transport.mock.calls[0]?.[0]).toBe("http://e2b-api.test/sandboxes/sandbox");
        expect(guest).toHaveBeenCalledOnce();
      }),
    );
});
