import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, ThreadId, PortableThreadCommand } from "@t3tools/contracts";
import { RelayThreadVmCreateRequest, DEFAULT_THREAD_VM_POLICY } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayRepositoryId } from "@t3tools/contracts/relay";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import { layer, ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import * as ManagedRelayTenancy from "./managedRelayTenancy.ts";
import { relayProtectedErrorMessage } from "./errorPresentation.ts";

const decodeVmCreateRequest = Schema.decodeUnknownSync(RelayThreadVmCreateRequest);

describe("thread VM policy client", () => {
  it.effect("carries authentication and the policy revision through the shared client", () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const policy = { organizationId: "org-test", revision: 2, policy: DEFAULT_THREAD_VM_POLICY };
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
      });
      if (request.method === "PUT") expect(await request.json()).toEqual(policy);
      return Response.json(policy);
    };
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient;
      expect(yield* client.getThreadVmPolicy({ clerkToken: "signed-in-token" })).toEqual(policy);
      expect(
        yield* client.updateThreadVmPolicy({ clerkToken: "signed-in-token", payload: policy }),
      ).toEqual(policy);
      expect(calls).toEqual([
        {
          url: "https://relay.example.test/v1/organization/thread-vm-policy",
          method: "GET",
          authorization: "Bearer signed-in-token",
        },
        {
          url: "https://relay.example.test/v1/organization/thread-vm-policy",
          method: "PUT",
          authorization: "Bearer signed-in-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(remoteHttpClientLayer(fetchFn)),
        ),
      ),
    );
  });

  it.effect("keeps policy revision conflicts visible to the caller", () =>
    Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient;
      const error = yield* Effect.flip(
        client.updateThreadVmPolicy({
          clerkToken: "token",
          payload: { organizationId: "org-test", revision: 1, policy: DEFAULT_THREAD_VM_POLICY },
        }),
      );
      expect(error).toMatchObject({
        relayError: { _tag: "RelayTenancyConflictError", reason: "vm_policy_changed" },
      });
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(
            remoteHttpClientLayer(async () =>
              Response.json(
                {
                  _tag: "RelayTenancyConflictError",
                  code: "tenancy_conflict",
                  reason: "vm_policy_changed",
                  traceId: "trace-test",
                },
                { status: 409 },
              ),
            ),
          ),
        ),
      ),
    ),
  );
});

it.effect("reads retained thread history directly from the relay with bounded pagination", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const client = yield* ManagedRelayTenancyClient;
    const page = yield* client.getPortableThreadHistory({
      clerkToken: "history-token",
      threadId: ThreadId.make("saved-thread"),
      after: 12,
      limit: 50,
    });
    expect(page).toEqual({ entries: [] });
    expect(calls).toEqual([
      "https://relay.example.test/v1/threads/saved-thread/history?after=12&limit=50",
    ]);
  }).pipe(
    Effect.provide(
      layer({ relayUrl: "https://relay.example.test" }).pipe(
        Layer.provide(
          remoteHttpClientLayer(async (input, init) => {
            const request = new Request(input, init);
            expect(request.headers.get("authorization")).toBe("Bearer history-token");
            calls.push(request.url);
            return Response.json({ entries: [] });
          }),
        ),
      ),
    ),
  );
});

it.effect(
  "submits a durable command and reads its pending receipt without treating it as executed",
  () => {
    const threadId = ThreadId.make("portable-thread");
    const command = {
      type: "thread.queue.pause" as const,
      threadId,
      commandId: CommandId.make("pause-1"),
      createdAt: "2026-10-02T00:00:00Z",
    };
    const pending = { commandId: command.commandId, position: 3, receipt: null };
    const calls: string[] = [];
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient;
      expect(
        yield* client.stagePortableThreadCommand({ clerkToken: "token", threadId, command }),
      ).toEqual(pending);
      expect(
        yield* client.getPortableThreadCommandReceipt({
          clerkToken: "token",
          threadId,
          commandId: command.commandId,
        }),
      ).toEqual(pending);
      expect(calls).toEqual([
        "POST https://relay.example.test/v1/threads/portable-thread/commands",
        "GET https://relay.example.test/v1/threads/portable-thread/commands/pause-1",
      ]);
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(
            remoteHttpClientLayer(async (input, init) => {
              const request = new Request(input, init);
              expect(request.headers.get("authorization")).toBe("Bearer token");
              calls.push(`${request.method} ${request.url}`);
              if (request.method === "POST") expect(await request.json()).toEqual({ command });
              return Response.json(pending);
            }),
          ),
        ),
      ),
    );
  },
);

const isPortableCommand = Schema.is(PortableThreadCommand);

it("excludes cross-project mutations and permanent deletion from the ordinary portable inbox", () => {
  for (const type of [
    "project.delete",
    "thread.create",
    "thread.delete",
    "thread.history.import",
    "thread.pin.reorder",
    "thread.active.reorder",
  ]) {
    expect(
      isPortableCommand({
        type,
        threadId: "thread",
        commandId: "command",
        projectId: "project",
      }),
    ).toBe(false);
  }
});

it.effect(
  "preserves durable replacement identity and explicit selection through the shared client",
  () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const requestId = "replacement-test",
      threadId = ThreadId.make("thread-test");
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const selection = request.url.endsWith("/select"),
        cancellation = request.url.endsWith("/cancel");
      calls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: selection ? await request.json() : null,
      });
      if (request.url.endsWith("/candidates"))
        return Response.json([{ allocationId: "old-vm", threadId, state: "paused" }]);
      return Response.json({
        requestId,
        threadId,
        phase: cancellation ? "cancelled" : selection ? "waiting" : "awaiting_choice",
        victimAllocationId: selection ? "old-vm" : null,
        errorCode: null,
      });
    };
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient;
      expect(
        (yield* client.getThreadVmReplacement({ clerkToken: "account-token", requestId })).phase,
      ).toBe("awaiting_choice");
      expect(
        yield* client.getThreadVmReplacementCandidates({ clerkToken: "account-token", requestId }),
      ).toEqual([{ allocationId: "old-vm", threadId, state: "paused" }]);
      expect(
        (yield* client.selectThreadVmReplacement({
          clerkToken: "account-token",
          requestId,
          victimAllocationId: "old-vm",
        })).phase,
      ).toBe("waiting");
      expect(
        (yield* client.cancelThreadVmReplacement({ clerkToken: "account-token", requestId })).phase,
      ).toBe("cancelled");
      expect(calls).toEqual([
        {
          url: "https://relay.example.test/v1/thread-vm-replacements/replacement-test",
          method: "GET",
          authorization: "Bearer account-token",
          body: null,
        },
        {
          url: "https://relay.example.test/v1/thread-vm-replacements/replacement-test/candidates",
          method: "GET",
          authorization: "Bearer account-token",
          body: null,
        },
        {
          url: "https://relay.example.test/v1/thread-vm-replacements/replacement-test/select",
          method: "POST",
          authorization: "Bearer account-token",
          body: { victimAllocationId: "old-vm" },
        },
        {
          url: "https://relay.example.test/v1/thread-vm-replacements/replacement-test/cancel",
          method: "POST",
          authorization: "Bearer account-token",
          body: null,
        },
      ]);
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(remoteHttpClientLayer(fetchFn)),
        ),
      ),
    );
  },
);

describe("saved VM restore client", () => {
  it.effect("submits the exact selected backup with account authentication", () => {
    const threadId = ThreadId.make("backup-thread"),
      payload = {
        operationId: "01900000-0000-7000-8000-000000000001",
        allocationId: "01900000-0000-7000-8000-000000000002",
        expectedGeneration: 4,
        backup: {
          sourceAllocationId: "01900000-0000-7000-8000-000000000003",
          backupOperationId: "01900000-0000-7000-8000-000000000004",
          capturedAt: "2026-10-15T12:00:00.000Z",
          nativeCheckpointOperationId: "01900000-0000-7000-8000-000000000005",
        },
      };
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      const cancelling = request.url.endsWith("/cancel");
      expect(request.url).toBe(
        `https://relay.example.test/v1/threads/${threadId}/vm-backup-recovery${cancelling ? "/cancel" : ""}`,
      );
      expect(request.headers.get("authorization")).toBe("Bearer signed-in-token");
      expect(await request.json()).toEqual(payload);
      if (cancelling)
        return Response.json({ threadId, operationId: payload.operationId, phase: "cancelled" });
      return Response.json({
        status: "accepted",
        restore: {
          operationId: payload.operationId,
          allocationId: payload.allocationId,
          threadId,
          generation: 5,
          phase: "pending",
          errorCode: null,
        },
      });
    };
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient;
      expect(
        yield* client.restoreThreadVmBackup({ clerkToken: "signed-in-token", threadId, payload }),
      ).toMatchObject({
        status: "accepted",
        restore: { operationId: payload.operationId, generation: 5 },
      });
      expect(
        yield* client.cancelThreadVmBackupRecovery({
          clerkToken: "signed-in-token",
          threadId,
          payload,
        }),
      ).toEqual({ threadId, operationId: payload.operationId, phase: "cancelled" });
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(remoteHttpClientLayer(fetchFn)),
        ),
      ),
    );
  });
  it.effect("authenticates restore, status and cancellation with one immutable request", () => {
    const operationId = "01900000-0000-7000-8000-000000000001",
      threadId = ThreadId.make("thread-restore-test");
    const payload = {
      operationId,
      allocationId: "01900000-0000-7000-8000-000000000002",
      savedDiskOperationId: "01900000-0000-7000-8000-000000000003",
      expectedGeneration: 1,
    };
    const restore = {
      operationId,
      allocationId: payload.allocationId,
      threadId,
      generation: 2,
      phase: "pending",
      errorCode: null,
    };
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
      });
      if (request.url.endsWith("/vm-restores")) {
        expect(await request.json()).toEqual(payload);
        return Response.json({ status: "accepted", restore });
      }
      return Response.json({
        ...restore,
        phase: request.url.endsWith("/cancel") ? "aborting" : "committed",
      });
    };
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient;
      expect(
        yield* client.restoreThreadVm({ clerkToken: "signed-in-token", threadId, payload }),
      ).toMatchObject({ status: "accepted", restore: { operationId } });
      expect(
        yield* client.getThreadVmRestore({ clerkToken: "signed-in-token", threadId, operationId }),
      ).toMatchObject({ phase: "committed" });
      expect(
        yield* client.cancelThreadVmRestore({
          clerkToken: "signed-in-token",
          threadId,
          operationId,
        }),
      ).toMatchObject({ phase: "aborting" });
      expect(calls).toEqual([
        {
          url: `https://relay.example.test/v1/threads/${threadId}/vm-restores`,
          method: "POST",
          authorization: "Bearer signed-in-token",
        },
        {
          url: `https://relay.example.test/v1/threads/${threadId}/vm-restores/${operationId}`,
          method: "GET",
          authorization: "Bearer signed-in-token",
        },
        {
          url: `https://relay.example.test/v1/threads/${threadId}/vm-restores/${operationId}/cancel`,
          method: "POST",
          authorization: "Bearer signed-in-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(remoteHttpClientLayer(fetchFn)),
        ),
      ),
    );
  });
});

describe("Reset VM client", () => {
  it.effect(
    "sends one immutable authenticated reset request and reads or cancels only that operation",
    () => {
      const threadId = ThreadId.make("reset-thread"),
        operationId = "01900000-0000-7000-8000-000000000001";
      const payload = {
        operationId,
        allocationId: "01900000-0000-7000-8000-000000000002",
        expectedGeneration: 1,
        canonicalKey: "github.com/acme/repo",
        branch: "main",
        revision: "a".repeat(40),
      };
      const reset = {
        operationId,
        allocationId: payload.allocationId,
        threadId,
        generation: 2,
        phase: "pending",
        errorCode: null,
      };
      const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
      const fetchFn: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get("authorization"),
        });
        if (request.url.endsWith("/vm-resets")) {
          expect(await request.json()).toEqual(payload);
          return Response.json({ status: "accepted", reset });
        }
        return Response.json({
          ...reset,
          phase: request.url.endsWith("/cancel") ? "cancelling" : "importing",
        });
      };
      return Effect.gen(function* () {
        const client = yield* ManagedRelayTenancyClient;
        expect(
          yield* client.resetThreadVm({ clerkToken: "signed-in-token", threadId, payload }),
        ).toMatchObject({ status: "accepted", reset: { operationId } });
        expect(
          yield* client.getThreadVmReset({ clerkToken: "signed-in-token", threadId, operationId }),
        ).toMatchObject({ phase: "importing" });
        expect(
          yield* client.cancelThreadVmReset({
            clerkToken: "signed-in-token",
            threadId,
            operationId,
          }),
        ).toMatchObject({ phase: "cancelling" });
        expect(calls).toEqual([
          {
            url: `https://relay.example.test/v1/threads/${threadId}/vm-resets`,
            method: "POST",
            authorization: "Bearer signed-in-token",
          },
          {
            url: `https://relay.example.test/v1/threads/${threadId}/vm-resets/${operationId}`,
            method: "GET",
            authorization: "Bearer signed-in-token",
          },
          {
            url: `https://relay.example.test/v1/threads/${threadId}/vm-resets/${operationId}/cancel`,
            method: "POST",
            authorization: "Bearer signed-in-token",
          },
        ]);
      }).pipe(
        Effect.provide(
          layer({ relayUrl: "https://relay.example.test" }).pipe(
            Layer.provide(remoteHttpClientLayer(fetchFn)),
          ),
        ),
      );
    },
  );
});

it.effect(
  "permanent deletion submits explicit workspace-loss confirmation and reads the caller's cleanup receipt",
  () => {
    const threadId = ThreadId.make("delete-thread"),
      payload = {
        operationId: "01900000-0000-7000-8000-000000000001",
        expectedGeneration: 2,
        confirmWorkspaceLoss: true as const,
      };
    const receipt = {
      threadId,
      operationId: payload.operationId,
      generation: 2,
      phase: "stopping",
      errorCode: null,
    };
    const methods: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);
      expect(request.url).toBe("https://relay.example.test/v1/threads/delete-thread/deletion");
      expect(request.headers.get("authorization")).toBe("Bearer signed-in-token");
      if (request.method === "POST") expect(await request.json()).toEqual(payload);
      return Response.json(receipt);
    };
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient;
      expect(
        yield* client.permanentlyDeleteThread({ clerkToken: "signed-in-token", threadId, payload }),
      ).toEqual(receipt);
      expect(yield* client.getThreadDeletion({ clerkToken: "signed-in-token", threadId })).toEqual(
        receipt,
      );
      expect(methods).toEqual(["POST", "GET"]);
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(remoteHttpClientLayer(fetchFn)),
        ),
      ),
    );
  },
);

it.effect(
  "uses explicit authenticated VM lifecycle endpoints without environment connection requests",
  () => {
    const calls: Array<{ method: string; path: string }> = [];
    const threadId = ThreadId.make("vm-test");
    const status = {
      threadId,
      generation: 1,
      allocation: null,
      setupPhase: null,
      capacityState: null,
      activity: "unknown",
      pausePhase: null,
      resumePhase: null,
      backupPhase: null,
      lastVerifiedBackupAt: null,
      savedDisk: {
        operationId: "saved-operation",
        phase: "expired",
        savedAt: "2026-10-01",
        expiresAt: "2026-11-01",
      },
      reset: null,
      replacement: null,
    };
    const input = decodeVmCreateRequest({
      allocationId: "allocation",
      threadId,
      organizationId: "org",
      repositoryId: "repo",
      canonicalKey: "github.com/acme/test",
      branch: "main",
      revision: "a".repeat(40),
      initialState: {
        title: "Test",
        modelSelection: { instanceId: "codex", model: "test" },
        createdAt: "2026-10-07T00:00:00.000Z",
      },
    });
    const fetchFn: typeof fetch = async (url, init) => {
      const request = new Request(url, init),
        path = new URL(request.url).pathname;
      expect(request.headers.get("authorization")).toBe("Bearer vm-token");
      calls.push({ method: request.method, path });
      if (path.endsWith("/vm-status")) return Response.json(status);
      if (path.endsWith("/vm-setup")) return Response.json(null);
      if (path.endsWith("/vm-resume"))
        return Response.json({ operationId: "resume", phase: "waiting" });
      if (path.endsWith("/cancel"))
        return Response.json({ allocationId: "allocation", status: "pending_cleanup" });
      expect(await request.json()).toEqual(input);
      return Response.json({
        status: "quota_reached",
        maxVms: 1,
        reservedVms: 1,
        suggestedReplacement: null,
      });
    };
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient,
        auth = { clerkToken: "vm-token", threadId };
      expect(yield* client.getThreadVmStatus(auth)).toEqual(status);
      expect(yield* client.getThreadVmSetup(auth)).toBeNull();
      expect(yield* client.resumeThreadVm(auth)).toMatchObject({ phase: "waiting" });
      expect(yield* client.cancelThreadVmSetup(auth)).toMatchObject({ status: "pending_cleanup" });
      expect(
        yield* client.createThreadVm({ clerkToken: "vm-token", payload: input }),
      ).toMatchObject({ status: "quota_reached" });
      expect(calls).toEqual([
        { method: "GET", path: "/v1/threads/vm-test/vm-status" },
        { method: "GET", path: "/v1/threads/vm-test/vm-setup" },
        { method: "POST", path: "/v1/threads/vm-test/vm-resume" },
        { method: "POST", path: "/v1/threads/vm-test/vm-setup/cancel" },
        { method: "POST", path: "/v1/thread-vms" },
      ]);
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(remoteHttpClientLayer(fetchFn)),
        ),
      ),
    );
  },
);

it.effect(
  "discovers saved threads from the relay with authentication and a stable page cursor",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancyClient;
      expect(yield* client.listPortableThreads({ clerkToken: "list-token", limit: 25 })).toEqual({
        entries: [],
        next: "thread-a",
      });
      expect(
        yield* client.listPortableThreads({
          clerkToken: "list-token",
          after: "thread-a",
          limit: 25,
        }),
      ).toEqual({ entries: [], next: null });
      expect(calls).toEqual([
        "https://relay.example.test/v1/threads/portable?limit=25",
        "https://relay.example.test/v1/threads/portable?after=thread-a&limit=25",
      ]);
    }).pipe(
      Effect.provide(
        layer({ relayUrl: "https://relay.example.test" }).pipe(
          Layer.provide(
            remoteHttpClientLayer(async (input, init) => {
              const request = new Request(input, init);
              expect(request.headers.get("authorization")).toBe("Bearer list-token");
              calls.push(request.url);
              return Response.json({ entries: [], next: calls.length === 1 ? "thread-a" : null });
            }),
          ),
        ),
      ),
    );
  },
);

it.effect("downloads saved attachment bytes without an environment connection", () =>
  Effect.gen(function* () {
    const client = yield* ManagedRelayTenancyClient;
    const bytes = yield* client.downloadPortableThreadAttachment({
      clerkToken: "attachment-token",
      threadId: ThreadId.make("saved"),
      attachmentId: "note",
    });
    expect(new TextDecoder().decode(bytes)).toBe("original notes");
  }).pipe(
    Effect.provide(
      layer({ relayUrl: "https://relay.example.test" }).pipe(
        Layer.provide(
          remoteHttpClientLayer(async (input, init) => {
            const request = new Request(input, init);
            expect(request.headers.get("authorization")).toBe("Bearer attachment-token");
            expect(request.url).toBe(
              "https://relay.example.test/v1/threads/saved/attachments/note",
            );
            return new Response(new TextEncoder().encode("original notes"), {
              headers: { "content-type": "application/octet-stream" },
            });
          }),
        ),
      ),
    ),
  ),
);

function testLayer(fetchFn: typeof globalThis.fetch) {
  return ManagedRelayTenancy.layer({ relayUrl: "https://relay.example.test" }).pipe(
    Layer.provide(remoteHttpClientLayer(fetchFn)),
  );
}

it.effect(
  "preserves the observed workflow revision when sending preparation and cancellation retries",
  () => {
    const bodies: unknown[] = [];
    const fetchFn = (async (input, init) => {
      const request = new Request(input, init);
      bodies.push(await request.json());
      expect(request.headers.get("authorization")).toBe("Bearer maintainer-token");
      return Response.json({
        jobId: "job-1",
        repositoryId: "repo-1",
        workflowId: "workflow-1",
        environmentId: "env-1",
        instruction: "Fix issue",
        status: "paused",
        detail: "Setup failed",
        workflow: null,
        progress: {
          revision: 5,
          status: "paused",
          threadId: "workflow:job-1:agent",
          detail: "Setup failed",
          checkpoint: null,
          retryablePreparation: true,
        },
        createdAt: "2026-10-08T12:00:00Z",
        updatedAt: "2026-10-08T12:00:00Z",
      });
    }) satisfies typeof globalThis.fetch;
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
      yield* client.respondToWorkflowJob({
        clerkToken: "maintainer-token",
        repositoryId: RelayRepositoryId.make("repo-1"),
        jobId: "job-1",
        payload: { operation: "retry_cancellation", expectedRevision: 8 },
      });
      yield* client.respondToWorkflowJob({
        clerkToken: "maintainer-token",
        repositoryId: RelayRepositoryId.make("repo-1"),
        jobId: "job-1",
        payload: { operation: "retry_preparation", expectedRevision: 5 },
      });
      yield* client.respondToWorkflowJob({
        clerkToken: "maintainer-token",
        repositoryId: RelayRepositoryId.make("repo-1"),
        jobId: "job-1",
        payload: { operation: "cancel" },
      });
      for (const operation of ["input", "request_changes"] as const)
        yield* client.respondToWorkflowJob({
          clerkToken: "maintainer-token",
          repositoryId: RelayRepositoryId.make("repo-1"),
          jobId: "job-1",
          payload: {
            operation,
            checkpointId: "checkpoint-7",
            expectedRevision: 7,
            text: "Preserve this answer",
          },
        });
      expect(bodies).toEqual([
        { operation: "retry_cancellation", expectedRevision: 8 },
        { operation: "retry_preparation", expectedRevision: 5 },
        { operation: "cancel" },
        {
          operation: "input",
          checkpointId: "checkpoint-7",
          expectedRevision: 7,
          text: "Preserve this answer",
        },
        {
          operation: "request_changes",
          checkpointId: "checkpoint-7",
          expectedRevision: 7,
          text: "Preserve this answer",
        },
      ]);
    }).pipe(Effect.provide(testLayer(fetchFn)));
  },
);

describe("organization issue tracker client", () => {
  it.effect("uses the current organization's bearer for listing and changing connections", () => {
    const requests: { url: string; method: string; bearer: string | null; body: unknown }[] = [];
    const connection = {
      service: "jira",
      status: "connected",
      accountLabel: "Team Jira",
      updatedAt: "2026-09-30T10:00:00Z",
    };
    const fetchFn = (async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        bearer: request.headers.get("authorization"),
        body: request.body ? await request.json() : null,
      });
      if (request.method === "DELETE") return Response.json({ ok: true });
      if (request.url.includes("/replacement/"))
        return Response.json({ connections: [connection] });
      if (request.method === "POST")
        return Response.json({
          authorizationUrl: "https://linear.app/oauth/authorize?state=test-state",
          authorizationId: "attempt",
          connection: { ...connection, service: "linear", status: "connecting" },
        });
      return Response.json({ connections: [connection] });
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
      const result = yield* client.listIssueTrackerConnections({ clerkToken: "member-token" });
      expect(result.connections).toEqual([connection]);
      yield* client.startLinearAuthorization({ clerkToken: "admin-token" });
      yield* client.disconnectIssueTracker({ clerkToken: "admin-token", service: "jira" });
      yield* client.confirmLinearReplacement({ clerkToken: "admin-token", proposalId: "proposal" });
      yield* client.cancelLinearReplacement({ clerkToken: "admin-token", proposalId: "proposal" });
      expect(requests).toEqual([
        {
          url: "https://relay.example.test/v1/user/issue-trackers",
          method: "GET",
          bearer: "Bearer member-token",
          body: null,
        },
        {
          url: "https://relay.example.test/v1/user/issue-trackers/linear/authorize",
          method: "POST",
          bearer: "Bearer admin-token",
          body: { writes: false },
        },
        {
          url: "https://relay.example.test/v1/user/issue-trackers/jira",
          method: "DELETE",
          bearer: "Bearer admin-token",
          body: null,
        },
        ...["confirm", "cancel"].map((action) => ({
          url: `https://relay.example.test/v1/user/issue-trackers/linear/replacement/${action}`,
          method: "POST",
          bearer: "Bearer admin-token",
          body: { proposalId: "proposal" },
        })),
      ]);
    }).pipe(Effect.provide(testLayer(fetchFn)));
  });

  it.effect(
    "keeps an actionable authorization failure instead of an opaque transport error",
    () => {
      const message = "Atlassian denied authorization. Check your Jira access.";
      const fetchFn = (() =>
        Promise.resolve(
          Response.json(
            {
              _tag: "RelayIssueTrackerError",
              code: "forbidden",
              message,
              traceId: "trace-jira-access",
            },
            { status: 400 },
          ),
        )) satisfies typeof globalThis.fetch;

      return Effect.gen(function* () {
        const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
        const error = yield* client
          .startJiraAuthorization({
            clerkToken: "admin-token",
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ManagedRelayRequestFailedError");
        if (error._tag !== "ManagedRelayRequestFailedError" || !error.relayError)
          throw new Error("Expected a typed relay failure");
        expect(relayProtectedErrorMessage(error.relayError)).toBe(message);
        expect(error.traceId).toBe("trace-jira-access");
      }).pipe(Effect.provide(testLayer(fetchFn)));
    },
  );
});

it.effect("starts Jira OAuth with only the administrator's relay session", () => {
  const requests: Request[] = [];
  const fetchFn = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      authorizationUrl: "https://mcp.atlassian.com/v1/authorize?state=test",
      authorizationId: "attempt",
      connection: {
        service: "jira",
        status: "connecting",
        accountLabel: null,
        updatedAt: "2026-10-01",
      },
    });
  }) satisfies typeof globalThis.fetch;
  return Effect.gen(function* () {
    const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
    const result = yield* client.startJiraAuthorization({
      clerkToken: "admin-token",
    });
    expect(result.authorizationUrl).toContain("mcp.atlassian.com");
    const request = requests[0]!;
    expect(request.url).toBe("https://relay.example.test/v1/user/issue-trackers/jira/authorize");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer admin-token");
    expect(yield* Effect.promise(() => request.json())).toEqual({ writes: false });
  }).pipe(Effect.provide(testLayer(fetchFn)));
});

it.effect.each(["select", "cancel"] as const)(
  "sends the %s action with the exact Jira authorization attempt",
  (action) => {
    const requests: Request[] = [];
    const fetchFn = (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ connections: [] });
    }) satisfies typeof globalThis.fetch;
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
      if (action === "select")
        yield* client.selectJiraSite({
          clerkToken: "admin-token",
          payload: { authorizationId: "attempt", cloudId: "cloud" },
        });
      else
        yield* client.cancelJiraSelection({
          clerkToken: "admin-token",
          authorizationId: "attempt",
        });
      const request = requests[0]!;
      expect(request.url).toBe(
        `https://relay.example.test/v1/user/issue-trackers/jira/${action === "select" ? "select-site" : "cancel-selection"}`,
      );
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer admin-token");
      expect(yield* Effect.promise(() => request.json())).toEqual(
        action === "select"
          ? { authorizationId: "attempt", cloudId: "cloud" }
          : { authorizationId: "attempt" },
      );
    }).pipe(Effect.provide(testLayer(fetchFn)));
  },
);

it.effect("requests bounded workflow pages without losing the scoped cursor", () => {
  const seen: URL[] = [];
  const fetchFn = (async (input, init) => {
    const request = new Request(input, init);
    seen.push(new URL(request.url));
    expect(request.headers.get("authorization")).toBe("Bearer page-token");
    return Response.json({ jobs: [], nextCursor: null });
  }) satisfies typeof globalThis.fetch;
  return Effect.gen(function* () {
    const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
    expect(
      yield* client.pageWorkflowJobs({
        clerkToken: "page-token",
        repositoryId: RelayRepositoryId.make("repo"),
        query: { view: "active", limit: 25, cursor: "scope:opaque/cursor" },
      }),
    ).toEqual({ jobs: [], nextCursor: null });
    expect(seen[0]!.pathname).toBe("/v1/repositories/repo/workflow-jobs/page");
    expect(seen[0]!.searchParams.get("limit")).toBe("25");
    expect(seen[0]!.searchParams.get("cursor")).toBe("scope:opaque/cursor");
  }).pipe(Effect.provide(testLayer(fetchFn)));
});

it.effect("keeps legacy catalog capability unknown and retains the legacy array helper", () =>
  Effect.gen(function* () {
    const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
    const input = { clerkToken: "token", repositoryId: RelayRepositoryId.make("repo") };
    expect(yield* client.readWorkflowCatalog(input)).toEqual({ workflows: [] });
    expect(yield* client.listWorkflows(input)).toEqual([]);
  }).pipe(Effect.provide(testLayer(async () => Response.json({ workflows: [] })))),
);
