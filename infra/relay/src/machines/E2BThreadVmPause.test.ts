import { ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeE2BThreadVmPause } from "./E2BThreadVmPause.ts";

const bootId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const pauseId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
// Existing guest-server seal, independently computed from the pause UUID.
const sealedOperationId = "1de0d88279f76ebcb102a03fa2cf5693";
const identity = {
  operationId: "provision",
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: RelayRepositoryId.make("repo"),
    generation: 1,
  },
};
const settings = {
  apiUrl: "http://e2b-api.test",
  sandboxUrl: "http://e2b-sandbox.test",
  apiKey: Redacted.make("test"),
  templateId: "template:build-version",
  hostAddresses: [],
  timeoutMs: 60_000,
};
const transport = vi.fn(async () =>
  Response.json({
    sandboxID: "sandbox",
    templateID: "template",
    state: "running",
    envdVersion: "1",
    envdAccessToken: "token",
    lifecycle: { autoResume: false },
    metadata: {
      "launchpad.managed": "thread-vm-v1",
      "launchpad.allocation_id": "allocation",
      "launchpad.operation_id": "provision",
      "launchpad.thread_id": "thread",
      "launchpad.generation": "1",
    },
  }),
);

describe("thread VM guest pause gate", () => {
  for (const sealedBy of [null, "cccccccccccccccccccccccccccccccc"]) {
    it.effect(
      `native timeout resume verifies an unsealed gate without reopening another operation (${sealedBy})`,
      () =>
        Effect.gen(function* () {
          const guest = vi.fn(async () => ({
            exitCode: 0,
            stdout: JSON.stringify({ bootId, sealedBy, stopped: true, groups: [] }),
          }));
          const gate = makeE2BThreadVmPause(settings, transport as typeof fetch, guest);
          const result = yield* gate
            .reopenAfterResume("sandbox", identity, null)
            .pipe(Effect.result);
          expect(result._tag).toBe(sealedBy === null ? "Success" : "Failure");
          expect(guest.mock.calls).toEqual([
            [expect.anything(), "/usr/local/bin/launchpad-workload inspect"],
          ]);
        }),
    );
  }
  for (const initiallySealed of [false, true]) {
    it.effect(
      `seals a verified idle guest and reopens its own seal after explicit wake (already sealed: ${initiallySealed})`,
      () =>
        Effect.gen(function* () {
          let sealed = initiallySealed;
          const guest = vi.fn(async (_connection: unknown, command: string) => {
            if (command === "/usr/local/bin/launchpad-workload inspect")
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  bootId,
                  sealedBy: sealed ? sealedOperationId : null,
                  stopped: true,
                  groups: [],
                }),
              };
            if (command === `/usr/local/bin/launchpad-workload seal ${bootId} ${sealedOperationId}`)
              sealed = true;
            else if (
              command === `/usr/local/bin/launchpad-workload reopen ${bootId} ${sealedOperationId}`
            )
              sealed = false;
            else throw new Error("Unexpected guest command");
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                bootId,
                sealedBy: sealed ? sealedOperationId : null,
                stopped: true,
                groups: [],
              }),
            };
          });
          const gate = makeE2BThreadVmPause(settings, transport as typeof fetch, guest);
          expect(yield* gate.seal("sandbox", identity, pauseId)).toEqual({ bootId, idle: true });
          expect(sealed).toBe(true);
          yield* gate.reopenAfterResume("sandbox", identity, pauseId);
          expect(sealed).toBe(false);
          const calls = guest.mock.calls.length;
          yield* gate.reopenAfterResume("sandbox", identity, pauseId);
          expect(guest.mock.calls.length).toBe(calls + 1);
        }),
    );
  }
  it.effect("does not reopen a gate sealed by a different operation", () =>
    Effect.gen(function* () {
      const guest = vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          bootId,
          sealedBy: "cccccccccccccccccccccccccccccccc",
          stopped: true,
          groups: [],
        }),
      }));
      const gate = makeE2BThreadVmPause(settings, transport as typeof fetch, guest);
      const error = yield* gate.reopenAfterResume("sandbox", identity, pauseId).pipe(Effect.flip);
      expect(error._tag).toBe("ThreadVmComputeError");
      expect(guest.mock.calls).toEqual([
        [expect.anything(), "/usr/local/bin/launchpad-workload inspect"],
      ]);
    }),
  );
});
