import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { RepositoryWorkflow, RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import {
  setWorkflowSessionAccount,
  workflowDraftAtom,
  discardWorkflowEditor,
  clearWorkflowScope,
  workflowEditorDirty,
  workflowDraftAutomationResolved,
  workflowSessionKey,
  updateWorkflowDrafts,
  type WorkflowEditorDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { saveWorkflowDraft, runWorkflowDraft } from "./workflowOperations";

vi.mock("../../lib/utils", () => {
  let requestId = 0;
  return { randomUUID: () => `request-${++requestId}` };
});
const scope = {
  accountId: "account",
  organizationId: "organization",
  repositoryId: RelayRepositoryId.make("repository"),
};
const saved: RepositoryWorkflow = {
  workflowId: "workflow",
  repositoryId: scope.repositoryId,
  organizationId: scope.organizationId,
  revision: 1,
  archived: false,
  definition: {
    name: "Workflow",
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
    steps: [
      { id: "agent", kind: "agent", title: "Agent", instruction: "Work", modelSelection: null },
    ],
  },
  createdAt: "2026-10-13",
  updatedAt: "2026-10-13",
};
const job: RepositoryWorkflowJob = {
  jobId: "job",
  repositoryId: scope.repositoryId,
  workflowId: saved.workflowId,
  environmentId: saved.definition.environmentId,
  instruction: "Task",
  status: "queued",
  detail: null,
  workflow: null,
  progress: null,
  createdAt: "2026-10-13",
  updatedAt: "2026-10-13",
};
const editor = (): WorkflowEditorDraft => ({
  workflowId: saved.workflowId,
  definition: saved.definition,
  baseline: null,
  selectedStepId: "agent",
  targetConfirmed: true,
  operation: null,
  error: null,
});
const key = workflowSessionKey(scope, saved.workflowId);
const seed = () =>
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: { [key]: editor() },
    runs: { [key]: { instruction: "Task", operation: null, startedJobId: null, error: null } },
  }));
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
  seed();
});

describe("workflow writes surviving navigation", () => {
  it("keeps Save pending outside its component and prevents a duplicate request", async () => {
    const result = deferred<RepositoryWorkflow>();
    const save = vi.fn(() => result.promise);
    const pending = saveWorkflowDraft(scope, saved.workflowId, save);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation?.state).toBe("pending");
    expect(await saveWorkflowDraft(scope, saved.workflowId, save)).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    result.resolve(saved);
    expect(await pending).toEqual(saved);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.baseline).toEqual(saved);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation).toBeNull();
  });
  it("retains an uncertain Create ID and retries optimistic concurrency with that same ID", async () => {
    const save = vi.fn(async () => {
      throw new Error("Reply lost");
    });
    await saveWorkflowDraft(scope, saved.workflowId, save);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation?.state).toBe("uncertain");
    const retry = vi.fn(async () => saved);
    await saveWorkflowDraft(scope, saved.workflowId, retry);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: saved.workflowId, expectedRevision: 0 }),
    );
  });
  it("does not overwrite a replacement editor with a late acknowledgement", async () => {
    const result = deferred<RepositoryWorkflow>();
    const pending = saveWorkflowDraft(scope, saved.workflowId, () => result.promise);
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      editors: { [key]: { ...editor(), definition: { ...saved.definition, name: "Replacement" } } },
    }));
    result.resolve(saved);
    expect(await pending).toBeNull();
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.definition.name).toBe(
      "Replacement",
    );
  });
  it("keeps one Run request in flight and retains its acknowledged job link after unmount", async () => {
    const result = deferred<RepositoryWorkflowJob>();
    const start = vi.fn(() => result.promise);
    const pending = runWorkflowDraft(scope, saved.workflowId, start);
    expect(await runWorkflowDraft(scope, saved.workflowId, start)).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    result.resolve(job);
    expect(await pending).toEqual(job);
    expect(appAtomRegistry.get(workflowDraftAtom).runs[key]).toMatchObject({
      instruction: "",
      startedJobId: "job",
      operation: null,
    });
    // A failed catalog read cannot change a completed write; there is no read chained to it.
    expect(appAtomRegistry.get(workflowDraftAtom).runs[key]?.startedJobId).toBe("job");
  });
  it("keeps instructions and reports an uncertain Run without silently retrying", async () => {
    const start = vi.fn(async () => {
      throw new Error("Disconnected");
    });
    expect(await runWorkflowDraft(scope, saved.workflowId, start)).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(appAtomRegistry.get(workflowDraftAtom).runs[key]).toMatchObject({
      instruction: "Task",
      startedJobId: null,
      operation: { state: "uncertain" },
    });
  });
  it("discards a previous account's late Run result", async () => {
    const result = deferred<RepositoryWorkflowJob>();
    const pending = runWorkflowDraft(scope, saved.workflowId, () => result.promise);
    setWorkflowSessionAccount(appAtomRegistry, "different-account");
    result.resolve(job);
    expect(await pending).toBeNull();
    expect(appAtomRegistry.get(workflowDraftAtom).runs).toEqual({});
  });
});

const autoTrigger = {
  provider: "linear",
  connectionId: "connection",
  grantId: "grant",
  teamId: "team",
  event: "issue_created",
  labelIds: [],
} as const;
const auto = { enabled: true, trigger: autoTrigger };
function installSavedAutomation() {
  const baseline = { ...saved, automation: auto };
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: { [key]: { ...editor(), baseline, automation: auto } },
  }));
  return baseline;
}
describe("complete automation Save receipts", () => {
  it("sends the complete rule and does not trust a relay that strips its receipt", async () => {
    installSavedAutomation();
    const save = vi.fn(async () => ({ ...saved, revision: 2 }));
    await saveWorkflowDraft(scope, saved.workflowId, save, undefined, {
      automationSupported: true,
      read: async () => ({ workflows: [], automationSupported: true }),
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ automation: auto }));
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation?.state).toBe("uncertain");
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.baseline?.revision).toBe(1);
    const retry = vi.fn();
    await saveWorkflowDraft(scope, saved.workflowId, retry, undefined, {
      automationSupported: true,
      read: async () => ({ workflows: [{ ...saved, revision: 2 }] }),
    });
    expect(retry).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.error).toContain(
      "does not support",
    );
  });
  for (const archived of [true, false])
    it(`reconciles lost ${archived ? "archive" : "restore"} replies as Off without writing twice`, async () => {
      const baseline = installSavedAutomation();
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
        ...state,
        editors: {
          [key]: { ...state.editors[key]!, baseline: { ...baseline, archived: !archived } },
        },
      }));
      const receipt = {
        ...baseline,
        revision: 2,
        archived,
        automation: { ...auto, enabled: false },
      };
      const options = {
        automationSupported: true,
        read: async () => ({ workflows: [receipt], automationSupported: true }),
      };
      const save = vi.fn(async () => {
        throw new Error("Reply lost");
      });
      await saveWorkflowDraft(scope, saved.workflowId, save, archived, options);
      const requestId = appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation?.requestId;
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ archived, automation: { ...auto, enabled: false } }),
      );
      expect(
        appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation?.automation?.enabled,
      ).toBe(false);
      const retry = vi.fn();
      expect(await saveWorkflowDraft(scope, saved.workflowId, retry, archived, options)).toEqual(
        receipt,
      );
      expect(retry).not.toHaveBeenCalled();
      expect(requestId).toBeTruthy();
      expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.automation?.enabled).toBe(false);
    });
  it("keeps newer trigger edits when reconciling an earlier Save", async () => {
    const baseline = installSavedAutomation();
    const receipt = { ...baseline, revision: 2 };
    const options = {
      automationSupported: true,
      read: async () => ({ workflows: [receipt], automationSupported: true }),
    };
    await saveWorkflowDraft(
      scope,
      saved.workflowId,
      async () => {
        throw new Error("Reply lost");
      },
      undefined,
      options,
    );
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      editors: {
        [key]: {
          ...state.editors[key]!,
          automation: { ...auto, trigger: { ...autoTrigger, teamId: "new-team" } },
        },
      },
    }));
    const save = vi.fn();
    await saveWorkflowDraft(scope, saved.workflowId, save, undefined, options);
    expect(save).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.baseline).toEqual(receipt);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.automation?.trigger?.teamId).toBe(
      "new-team",
    );
  });
  it("does not recreate a discarded editor when its in-flight Save completes", async () => {
    const result = deferred<RepositoryWorkflow>();
    const pending = saveWorkflowDraft(scope, saved.workflowId, () => result.promise);
    discardWorkflowEditor(appAtomRegistry, scope, saved.workflowId);
    result.resolve(saved);
    expect(await pending).toBeNull();
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]).toBeUndefined();
  });
});

it("preserves a saved rule when an editor retained from an older client has no automation field", async () => {
  installSavedAutomation();
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
    const { automation: _automation, ...draft } = state.editors[key]!;
    return { ...state, editors: { [key]: draft } };
  });
  const receipt = { ...saved, revision: 2, automation: auto };
  const save = vi.fn(async () => receipt);
  await saveWorkflowDraft(scope, saved.workflowId, save, undefined, {
    automationSupported: true,
    read: async () => ({ workflows: [], automationSupported: true }),
  });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ automation: auto }));
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.baseline).toEqual(receipt);
});

describe("immutable Save recovery", () => {
  it("does not weaken automation confirmation after relay support disappears", async () => {
    installSavedAutomation();
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      editors: { [key]: { ...state.editors[key]!, automation: { ...auto, enabled: false } } },
    }));
    await saveWorkflowDraft(
      scope,
      saved.workflowId,
      async () => {
        throw new Error("Reply lost");
      },
      undefined,
      {
        automationSupported: true,
        read: async () => ({ workflows: [], automationSupported: true }),
      },
    );
    const write = vi.fn();
    expect(
      await saveWorkflowDraft(scope, saved.workflowId, write, undefined, {
        automationSupported: false,
        read: async () => ({ workflows: [{ ...saved, revision: 2 }] }),
      }),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation).toMatchObject({
      state: "uncertain",
      includesAutomation: true,
    });
    expect(
      await saveWorkflowDraft(scope, saved.workflowId, write, undefined, {
        automationSupported: false,
        read: async () => ({
          workflows: [{ ...saved, revision: 2, automation: { ...auto, enabled: false } }],
          automationSupported: true,
        }),
      }),
    ).not.toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
  it("keeps omitted automation omitted when a legacy retry reaches an upgraded relay", async () => {
    const options = {
      automationSupported: false,
      read: async () => ({ workflows: [], automationSupported: true }),
    };
    await saveWorkflowDraft(
      scope,
      saved.workflowId,
      async () => {
        throw new Error("Reply lost");
      },
      undefined,
      options,
    );
    const write = vi.fn(
      async (_payload: Parameters<Parameters<typeof saveWorkflowDraft>[2]>[0]) => ({
        ...saved,
        automation: auto,
      }),
    );
    await saveWorkflowDraft(scope, saved.workflowId, write, undefined, {
      ...options,
      automationSupported: true,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).not.toHaveProperty("automation");
    const draft = appAtomRegistry.get(workflowDraftAtom).editors[key]!;
    expect(draft.automation).toEqual(auto);
    expect(workflowEditorDirty(draft)).toBe(false);
  });
  for (const detach of ["discard", "replace", "scope", "account"] as const)
    it(`does not retransmit after ${detach} during the recovery read`, async () => {
      await saveWorkflowDraft(scope, saved.workflowId, async () => {
        throw new Error("Reply lost");
      });
      const read = deferred<{ workflows: RepositoryWorkflow[]; automationSupported: boolean }>();
      const write = vi.fn(async () => saved);
      const pending = saveWorkflowDraft(scope, saved.workflowId, write, undefined, {
        automationSupported: false,
        read: () => read.promise,
      });
      if (detach === "discard") discardWorkflowEditor(appAtomRegistry, scope, saved.workflowId);
      else if (detach === "scope") clearWorkflowScope(appAtomRegistry, scope);
      else if (detach === "account") setWorkflowSessionAccount(appAtomRegistry, "other-account");
      else
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
          ...state,
          editors: {
            [key]: { ...editor(), definition: { ...saved.definition, name: "Replacement" } },
          },
        }));
      read.resolve({ workflows: [], automationSupported: true });
      expect(await pending).toBeNull();
      expect(write).not.toHaveBeenCalled();
      if (detach === "replace")
        expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.definition.name).toBe(
          "Replacement",
        );
      else expect(appAtomRegistry.get(workflowDraftAtom).editors[key]).toBeUndefined();
    });
  it("requires explicit reload or discard for a retained operation without captured wire mode", async () => {
    await saveWorkflowDraft(scope, saved.workflowId, async () => {
      throw new Error("Reply lost");
    });
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const { includesAutomation: _mode, ...operation } = state.editors[key]!.operation!;
      return { ...state, editors: { [key]: { ...state.editors[key]!, operation } } };
    });
    const write = vi.fn(async () => saved);
    await saveWorkflowDraft(scope, saved.workflowId, write, undefined, {
      automationSupported: true,
      read: async () => ({ workflows: [], automationSupported: true }),
    });
    expect(write).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation?.state).toBe("uncertain");
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.error).toContain("Reload");
  });
});

it("retransmits only the captured automation payload and preserves newer incomplete edits", async () => {
  const baseline = installSavedAutomation();
  const options = {
    automationSupported: true,
    read: async () => ({ workflows: [baseline], automationSupported: true }),
  };
  await saveWorkflowDraft(
    scope,
    saved.workflowId,
    async () => {
      throw new Error("Reply lost");
    },
    undefined,
    options,
  );
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: {
      [key]: {
        ...state.editors[key]!,
        targetConfirmed: false,
        definition: { ...saved.definition, name: "", projectId: ProjectId.make("later-target") },
        automation: { ...auto, trigger: { ...autoTrigger, teamId: "" } },
      },
    },
  }));
  const receipt = { ...baseline, revision: 2 };
  const write = vi.fn(
    async (_payload: Parameters<Parameters<typeof saveWorkflowDraft>[2]>[0]) => receipt,
  );
  expect(await saveWorkflowDraft(scope, saved.workflowId, write, undefined, options)).toEqual(
    receipt,
  );
  expect(write).toHaveBeenCalledExactlyOnceWith({
    workflowId: saved.workflowId,
    expectedRevision: 1,
    definition: baseline.definition,
    automation: auto,
    archived: false,
  });
  const draft = appAtomRegistry.get(workflowDraftAtom).editors[key]!;
  expect(draft.definition.name).toBe("");
  expect(draft.automation?.trigger?.teamId).toBe("");
  expect(draft.targetConfirmed).toBe(false);
  expect(draft.operation).toBeNull();
});

it("never includes unresolved existing automation in a new supported Save", async () => {
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: {
      [key]: { ...editor(), baseline: saved, automation: { enabled: false, trigger: null } },
    },
  }));
  const write = vi.fn(async () => ({ ...saved, revision: 2, automation: auto }));
  expect(
    await saveWorkflowDraft(scope, saved.workflowId, write, undefined, {
      automationSupported: true,
      read: async () => ({ workflows: [saved], automationSupported: true }),
    }),
  ).toBeNull();
  expect(write).not.toHaveBeenCalled();
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.error).toContain("Refresh or reload");
});
it("marks an omitted legacy automation receipt unresolved until a trusted read", async () => {
  const result = await saveWorkflowDraft(scope, saved.workflowId, async () => saved);
  expect(result).toEqual(saved);
  expect(
    workflowDraftAutomationResolved(appAtomRegistry.get(workflowDraftAtom).editors[key]!),
  ).toBe(false);
});
