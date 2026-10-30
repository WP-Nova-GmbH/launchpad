import { act, createElement, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  beforeEach,
  afterEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { SharedPromptSubmissions } from "./SharedPromptSubmissions";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { threadEnvironment } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { verifyStashedAttachmentUpload } from "../../lib/attachmentUploadQueue";
import {
  retainSharedPromptSubmission,
  setSharedPromptSubmissionAccount,
  useSharedPromptSubmissions,
  beginSharedPromptSubmission,
  rejectSharedPromptSubmission,
  forgetSharedPromptSubmission,
} from "../../sharedPromptSubmissionStore";
import { makeSubmissionRuntime, preparationBarrier } from "./submissionTestUtils";

vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => createElement("button", props),
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: ComponentProps<"textarea">) => createElement("textarea", props),
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({ verifyStashedAttachmentUpload: vi.fn() }));

const environmentId = EnvironmentId.make("retry-environment");
const threadId = ThreadId.make("retry-thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const projectId = ProjectId.make("retry-project");
const unknownReceipt = AsyncResult.success({ status: "unknown" as const });
let renderer: ReactTestRenderer | undefined;
let transport: ReturnType<typeof makeSubmissionRuntime>;
let original: ReturnType<typeof retainSharedPromptSubmission>;
let receipt: MockInstance<typeof threadEnvironment.getCommandReceipt.run>;
let finished: ReturnType<typeof preparationBarrier>;

function switchAccount(accountId: string) {
  setSharedPromptSubmissionAccount(accountId);
  appAtomRegistry.set(managedRelaySessionAtom, {
    accountId,
    readClerkToken: () => Effect.succeed(`${accountId}-token`),
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  const config = {
    environment: { capabilities: { sharedPromptQueue: true, sharedPreparation: true } },
  } as ServerConfig;
  vi.spyOn(serverEnvironment, "configValueAtom").mockReturnValue(Atom.make(config));
  switchAccount("alice");
  useSharedPromptSubmissions.setState({ entries: [] });
  original = retainSharedPromptSubmission(
    environmentId,
    {
      threadId,
      message: {
        messageId: MessageId.make("retry-message"),
        role: "user",
        text: "Read WP-218",
        attachments: [
          {
            type: "file",
            id: "saved-file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    true,
  );
  receipt = vi.spyOn(threadEnvironment.getCommandReceipt, "run").mockResolvedValue(unknownReceipt);
  vi.mocked(verifyStashedAttachmentUpload).mockResolvedValue({ status: "verified" });
  transport = makeSubmissionRuntime(appAtomRegistry, environmentId, true);
  vi.spyOn(threadEnvironment.enqueuePrompt, "run").mockImplementation((_registry, { input }) =>
    transport.enqueue(input),
  );
  finished = preparationBarrier();
  const start = threadEnvironment.startTurn.run;
  vi.spyOn(threadEnvironment.startTurn, "run").mockImplementation(async (...args) => {
    try {
      return await start(...args);
    } finally {
      void finished.wait();
    }
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  finished.release();
  appAtomRegistry.set(managedRelaySessionAtom, null);
  setSharedPromptSubmissionAccount(null);
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => appAtomRegistry.dispose());

async function render(representedMessageIds?: ReadonlyArray<string>) {
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <SharedPromptSubmissions
          threadRef={threadRef}
          projectId={projectId}
          unavailable={false}
          representedMessageIds={representedMessageIds}
        />
      </AppAtomRegistryProvider>,
    );
  });
}

function retryButton() {
  return renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry submission"))!;
}

describe("saved submission ownership", () => {
  it("removes stale recovery errors when the final saved copy is dismissed", async () => {
    await render();
    receipt.mockResolvedValueOnce(AsyncResult.failure(Cause.die(new Error("Offline"))));
    const click = async (label: string) => {
      const button = renderer!.root
        .findAllByType("button")
        .find((node) => node.children.includes(label))!;
      await act(() => button.props.onClick());
    };
    await click("Check outcome");
    expect(renderer!.root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
    await click("Dismiss saved copy");
    await click("I reviewed the task; dismiss");
    expect(
      renderer!.root.findAllByProps({ "aria-label": "Prompts waiting for acceptance" }),
    ).toHaveLength(0);
    expect(useSharedPromptSubmissions.getState().entries).toEqual([]);
  });

  it("preserves open dismissal controls during acceptance and closes them when its journal resolves", async () => {
    await render();
    const dismiss = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Dismiss saved copy"))!;
    await act(() => dismiss.props.onClick());
    await act(() =>
      renderer!.update(
        <AppAtomRegistryProvider>
          <SharedPromptSubmissions
            threadRef={threadRef}
            projectId={projectId}
            unavailable={false}
            representedMessageIds={["retry-message"]}
          />
        </AppAtomRegistryProvider>,
      ),
    );
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.children.includes("Keep saved copy")),
    ).toBe(true);
    await act(() => forgetSharedPromptSubmission(original.command.commandId));
    expect(
      renderer!.root.findAllByProps({ "aria-label": "Prompts waiting for acceptance" }),
    ).toHaveLength(0);
  });

  it("keeps active delivery inline and restores recovery after an unsuccessful attempt", async () => {
    const finish = beginSharedPromptSubmission(original.command.commandId);
    try {
      await render();
      expect(
        renderer!.root.findAllByProps({ "aria-label": "Prompts waiting for acceptance" }),
      ).toHaveLength(0);
      expect(useSharedPromptSubmissions.getState().entries).toEqual([original]);
      await act(() => finish());
      expect(retryButton()).toBeDefined();
      expect(useSharedPromptSubmissions.getState().entries).toEqual([original]);
    } finally {
      finish();
    }
  });

  it("hides a stale saved copy already represented by the queue while preserving rejection recovery", async () => {
    await render(["retry-message"]);
    expect(
      renderer!.root.findAllByProps({ "aria-label": "Prompts waiting for acceptance" }),
    ).toHaveLength(0);
    expect(useSharedPromptSubmissions.getState().entries).toEqual([original]);
    await act(() => rejectSharedPromptSubmission(original.command.commandId, "Not authorized"));
    expect(
      renderer!.root
        .findAllByProps({ role: "alert" })
        .some((node) => node.children.includes("Not authorized")),
    ).toBe(true);
  });

  it.each(["receipt", "attachment"] as const)(
    "holds the original submission when the account changes during %s checks",
    async (waitingOn) => {
      await render();
      const preparing = preparationBarrier();
      if (waitingOn === "receipt")
        receipt.mockImplementationOnce(async () => {
          await preparing.wait();
          return unknownReceipt;
        });
      else
        vi.mocked(verifyStashedAttachmentUpload).mockImplementationOnce(async () => {
          await preparing.wait();
          return { status: "verified" };
        });
      await act(() => retryButton().props.onClick());
      await preparing.entered;
      await act(() => switchAccount("bob"));
      await act(async () => {
        preparing.release();
      });
      expect(transport.requests).toHaveLength(0);
      expect(transport.dispatched).toHaveLength(0);
      expect(useSharedPromptSubmissions.getState().entries).toHaveLength(0);
      await act(() => switchAccount("alice"));
      expect(useSharedPromptSubmissions.getState().entries).toEqual([original]);
      expect(retryButton().props.disabled).toBe(false);
    },
  );

  it("retries with the original IDs and credentials when the account stays the same", async () => {
    await render();
    await act(async () => {
      retryButton().props.onClick();
      await finished.entered;
    });
    expect(transport.requests[0]?.headers.get("authorization")).toBe("Bearer alice-token");
    expect(transport.dispatched).toMatchObject([
      {
        type: "thread.prompt.enqueue",
        commandId: original.command.commandId,
        threadId,
        message: { messageId: "retry-message" },
        issueTrackerAuthorization: "personal-grant",
      },
    ]);
    expect(transport.dispatched[0]).not.toHaveProperty("expectedAccountId");
    expect(useSharedPromptSubmissions.getState().entries).toHaveLength(0);
  });
});
