import { ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { classifyThreadVmActivity, makeE2BThreadVmActivity } from "./E2BThreadVmActivity.ts";

const empty = { bootId: "boot", sealedBy: null, stopped: true, groups: [] } as const;
const group = (kind: "provider" | "terminal" | "process" | "transfer") => ({
  id: kind,
  bootId: "boot",
  kind,
});

describe("thread VM workload activity", () => {
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
  ] as const)
    it.effect(`reads current durable VM activity without waking it (${situation})`, () =>
      Effect.gen(function* () {
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
          unfinished: situation === "unfinished",
          processWorkIds: ["stopped-processes", "live-process"].includes(situation)
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
                  workloads:
                    situation === "live-process"
                      ? { ...empty, stopped: false, groups: [group("process")] }
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
          if (result._tag === "Success" && situation === "stopped-processes")
            expect(result.success).toEqual({
              activity: "idle",
              inactiveWorkIds: projection.processWorkIds,
            });
          else if (result._tag === "Success")
            expect(result.success).toBe(
              ["held", "foreign-environment", "old-generation"].includes(situation)
                ? "unknown"
                : [
                      "queued-prompt",
                      "queued-move",
                      "delivery-unknown",
                      "unfinished",
                      "live-process",
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
