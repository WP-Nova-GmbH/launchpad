import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  RelayAuthInvalidError,
  RelayOrganizationId,
  type RelayOrganizationMembership,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ManagedRelayRequestFailedError } from "./managedRelay.ts";
import {
  makeWorkflowVmPolicyController,
  readWorkflowVmPolicy,
  saveWorkflowVmPolicy,
  WorkflowVmPolicyScopeError,
} from "./workflowVmPolicy.ts";

const record = { organizationId: "org", revision: 1, maxRunningVms: 10 };
const capabilities = { configuration: true, execution: false };
const loaded = { record, capabilities, canEdit: true };

describe("workflow VM settings state", () => {
  it("saves only the workflow value and retains edits on conflict until explicit reload", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("VM policy changed; reload before saving"));
    const controller = makeWorkflowVmPolicyController({ read: async () => loaded, save });
    await controller.load();
    controller.edit("0");
    await controller.save();
    expect(save).toHaveBeenCalledWith({ ...record, maxRunningVms: 0 });
    expect(controller.getSnapshot()).toMatchObject({
      draft: "0",
      record,
      saved: false,
      saving: false,
      saveError: "VM policy changed; reload before saving",
    });
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({ draft: "10", saveError: null });
    save.mockResolvedValueOnce({ ...record, revision: 2, maxRunningVms: 0 });
    controller.edit("0");
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({
      record: { ...record, revision: 2, maxRunningVms: 0 },
      saved: true,
    });
  });
  it("does not write invalid input or member/unsupported configuration", async () => {
    const save = vi.fn();
    const controller = makeWorkflowVmPolicyController({ read: async () => loaded, save });
    await controller.load();
    controller.edit("1.5");
    await controller.save();
    expect(controller.getSnapshot().saveError).toContain("whole number");
    const member = makeWorkflowVmPolicyController({
      read: async () => ({ ...loaded, canEdit: false }),
      save,
    });
    await member.load();
    member.edit("2");
    await member.save();
    expect(member.getSnapshot().draft).toBe("10");
    const unsupported = makeWorkflowVmPolicyController({
      read: async () => ({ ...loaded, record: null, capabilities: null }),
      save,
    });
    await unsupported.load();
    await unsupported.save();
    expect(save).not.toHaveBeenCalled();
  });
  it("ignores late reads from disposed scopes and older reloads", async () => {
    const first = Promise.withResolvers<typeof loaded>();
    const second = Promise.withResolvers<typeof loaded>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const controller = makeWorkflowVmPolicyController({ read, save: vi.fn() });
    const pending = controller.load();
    controller.dispose();
    const latest = controller.load();
    second.resolve({ ...loaded, record: { ...record, maxRunningVms: 6 } });
    await latest;
    controller.edit("8");
    first.resolve(loaded);
    await pending;
    expect(controller.getSnapshot()).toMatchObject({
      draft: "8",
      record: { ...record, maxRunningVms: 6 },
    });
  });
  it("ignores a save reply after scope disposal and preserves the draft on read failure", async () => {
    const response = Promise.withResolvers<typeof record>();
    const read = vi
      .fn(async () => loaded)
      .mockResolvedValueOnce(loaded)
      .mockRejectedValueOnce(new Error("offline"));
    const save = vi.fn(() => response.promise);
    const controller = makeWorkflowVmPolicyController({ read, save });
    await controller.load();
    controller.edit("2");
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({
      draft: "2",
      recoveryDraft: "2",
      readError: "offline",
    });
    await controller.save();
    expect(save).not.toHaveBeenCalled();
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({
      draft: "10",
      recoveryDraft: null,
      readError: null,
    });
    controller.edit("2");
    const pending = controller.save();
    expect(save).toHaveBeenCalledWith({ ...record, maxRunningVms: 2 });
    controller.dispose();
    response.resolve({ ...record, revision: 2, maxRunningVms: 2 });
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ record, saved: false, draft: "2" });
  });
  const request = HttpClientRequest.get(
    "https://relay.example.test/v1/organization/workflow-vm-policy",
  );
  it.each([
    new WorkflowVmPolicyScopeError({ message: "Your organization changed." }),
    new ManagedRelayRequestFailedError({
      action: "read workflow VM limit",
      cause: undefined,
      relayError: new RelayAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_bearer",
        traceId: "trace",
      }),
    }),
    new ManagedRelayRequestFailedError({
      action: "read workflow VM limit",
      cause: new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({
          request,
          response: HttpClientResponse.fromWeb(request, new Response("Forbidden", { status: 403 })),
        }),
      }),
    }),
  ])("clears the draft after an access failure ($_tag)", async (error) => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(loaded)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(new Error("offline"));
    const controller = makeWorkflowVmPolicyController({ read, save: vi.fn() });
    await controller.load();
    controller.edit("2");
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({
      record: null,
      draft: "",
      recoveryDraft: null,
    });
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({ readError: "offline", recoveryDraft: null });
  });
});

const membership = (
  organizationId = "org",
  role: "admin" | "member" = "admin",
): RelayOrganizationMembership => ({
  organization: {
    organizationId: RelayOrganizationId.make(organizationId),
    name: "Organization",
    createdAt: "2026-11-02",
  },
  userId: "user",
  role,
  joinedAt: "2026-11-02",
});
const client = () => ({
  getOrganization: vi.fn().mockImplementation(() => Effect.succeed(membership())),
  getHealth: () =>
    Effect.succeed({ ok: true, service: "relay" as const, workflowVmCapabilities: capabilities }),
  getWorkflowVmPolicy: vi.fn().mockImplementation(() => Effect.succeed(record)),
  updateWorkflowVmPolicy: vi
    .fn()
    .mockImplementation(() => Effect.succeed({ ...record, revision: 2 })),
});
describe("workflow VM settings authorization scope", () => {
  it.effect("checks organization before writes and after reads", () =>
    Effect.gen(function* () {
      const api = client();
      api.getOrganization.mockImplementationOnce(() => Effect.succeed(membership("other")));
      expect(
        yield* Effect.flip(saveWorkflowVmPolicy(api, "token", { userId: "user" }, record)),
      ).toMatchObject({ message: expect.stringContaining("organization changed") });
      expect(api.updateWorkflowVmPolicy).not.toHaveBeenCalled();
      api.getOrganization
        .mockImplementationOnce(() => Effect.succeed(membership()))
        .mockImplementationOnce(() => Effect.succeed(membership("other")));
      expect(
        yield* Effect.flip(readWorkflowVmPolicy(api, "token", { userId: "user" })),
      ).toMatchObject({ message: expect.stringContaining("organization changed") });
    }),
  );
  it.effect("rechecks current role before writes and rejects another account", () =>
    Effect.gen(function* () {
      const api = client();
      api.getOrganization.mockImplementationOnce(() => Effect.succeed(membership("org", "member")));
      expect(
        yield* Effect.flip(saveWorkflowVmPolicy(api, "token", { userId: "user" }, record)),
      ).toMatchObject({ message: expect.stringContaining("admin") });
      expect(
        yield* Effect.flip(readWorkflowVmPolicy(api, "token", { userId: "other-user" })),
      ).toMatchObject({ message: expect.stringContaining("account") });
      expect(api.updateWorkflowVmPolicy).not.toHaveBeenCalled();
    }),
  );
});
