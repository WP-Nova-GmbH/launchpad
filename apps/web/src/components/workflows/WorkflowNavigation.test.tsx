import { act, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { EnvironmentId, ProjectId, ThreadId, type ThreadWorkflowJob } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { WorkflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";
import {
  emptyWorkflowJobRead,
  workflowJobReadAtom,
  workflowSessionKey,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useWorkflowConversation, WorkflowConversationHeader } from "./WorkflowNavigation";

vi.mock("../../state/workflowVmFollowUp", () => ({ pushWorkflowVmFollowUp: "follow-up-push" }));
const fixture = vi.hoisted(() => ({
  origin: undefined as WorkflowResultOrigin | undefined,
  call: vi.fn(),
  push: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.push }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("../../cloud/managedRelayState", () => ({
  useManagedRelayOrganizationCatalog: () => ({
    data: { repositories: [{ repository: { ...fixture.origin, name: "repository" } }] },
  }),
}));
vi.mock("./workflowState", () => ({
  WORKFLOW_REVIEW_ANCHOR: "workflow-review",
  useWorkflowClient: () => fixture.call,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: object) => unknown }) =>
    select({ state: { workflowOrigin: fixture.origin } }),
  Link: ({ hash, children }: PropsWithChildren<{ hash: string }>) => (
    <a href={`#${hash}`}>{children}</a>
  ),
}));

const checkpoint = { checkpointId: "review", turnId: "saved-turn", checkpointTurnCount: 3 };
const origin = {
  accountId: "account",
  organizationId: "organization",
  repositoryId: RelayRepositoryId.make("repository"),
  jobId: "run",
  threadId: ThreadId.make("workflow:run:agent"),
  reviewCheckpoint: checkpoint,
};
const review = {
  jobId: origin.jobId,
  repositoryId: origin.repositoryId,
  workflowId: "workflow",
  runtime: {
    kind: "machine",
    environmentId: EnvironmentId.make("machine"),
    projectId: ProjectId.make("project"),
  },
  instruction: "Review changes",
  status: "awaiting_review",
  detail: null,
  workflow: null,
  progress: {
    revision: 1,
    status: "awaiting_review",
    threadId: origin.threadId,
    detail: null,
    checkpoint: { ...checkpoint, checkpointRef: "ref" },
  },
  createdAt: "2026-11-19",
  updatedAt: "2026-11-19",
} satisfies RepositoryWorkflowJob;

function Header({ threadJob }: { threadJob: typeof ThreadWorkflowJob.Type | null | undefined }) {
  const generation = fixture.origin?.workflowVmFollowUpGeneration;
  const conversation = useWorkflowConversation({
    environmentId: EnvironmentId.make("machine"),
    origin: fixture.origin ?? null,
    threadId: origin.threadId,
    threadTitle: "Run",
    threadJob,
    followUp: generation !== undefined,
    capabilities:
      generation === undefined
        ? undefined
        : {
            repositoryIdentity: true,
            workflowVmFollowUp: { threadId: origin.threadId, generation },
          },
  });
  return conversation ? <WorkflowConversationHeader conversation={conversation} /> : null;
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  fixture.origin = origin;
  fixture.call.mockReset();
  fixture.push.mockReset();
  appAtomRegistry.set(managedRelaySessionAtom, {
    accountId: origin.accountId,
    readClerkToken: () => Effect.succeed("token"),
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  appAtomRegistry.set(managedRelaySessionAtom, null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mountHeader(job: RepositoryWorkflowJob | null, status: string | null) {
  const key = workflowSessionKey(origin, origin.jobId);
  appAtomRegistry.set(workflowJobReadAtom, {
    accountId: origin.accountId,
    activeKey: key,
    sequence: 1,
    jobs: { [key]: { ...emptyWorkflowJobRead, job } },
  });
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <Header
          threadJob={
            status ? { jobId: origin.jobId, repositoryId: origin.repositoryId, status } : null
          }
        />
      </AppAtomRegistryProvider>,
    );
  });
}

it.each([
  {
    case: "current review",
    job: review,
    status: "awaiting_review",
    title: "Review checkpoint",
    returning: true,
  },
  {
    case: "earlier turn of the same review",
    job: {
      ...review,
      progress: {
        ...review.progress,
        checkpoint: { ...review.progress.checkpoint, turnId: "new-turn" },
      },
    },
    status: "awaiting_review",
    title: "Earlier checkpoint",
    returning: false,
  },
  {
    case: "completed review",
    job: { ...review, status: "done" as const },
    status: null,
    title: "Saved checkpoint",
    returning: false,
  },
  {
    case: "live run advanced",
    job: review,
    status: "running",
    title: "Saved checkpoint",
    returning: false,
  },
  {
    case: "run read unavailable",
    job: review,
    status: "awaiting_review",
    title: "Saved checkpoint",
    returning: false,
    readFails: true,
  },
  {
    case: "paused review",
    job: {
      ...review,
      status: "paused" as const,
      progress: {
        ...review.progress,
        status: "paused" as const,
        underlyingStatus: "awaiting_review" as const,
      },
    },
    status: "paused",
    title: "Review checkpoint",
    returning: true,
  },
])(
  "links back to the right place for $case",
  async ({ job, status, title, returning, readFails }) => {
    if (readFails) fixture.call.mockRejectedValue(new Error("Review unavailable"));
    else fixture.call.mockResolvedValue(job);
    await mountHeader(job, status);
    expect(renderer!.root.findAllByType("span").some((span) => span.children.includes(title))).toBe(
      true,
    );
    const link = renderer!.root.findByType("a");
    expect(link.children).toContain(returning ? "Return to review" : "Back to run");
    expect(link.props.href).toBe(returning ? "#workflow-review" : "#");
  },
);

it("updates the return link when the review changes while the diff is open", async () => {
  fixture.call.mockResolvedValue(review);
  await mountHeader(review, "awaiting_review");
  expect(renderer!.root.findByType("a").children).toContain("Return to review");

  fixture.call.mockResolvedValue({
    ...review,
    progress: {
      ...review.progress,
      revision: 2,
      checkpoint: { ...review.progress.checkpoint, checkpointId: "next-review" },
    },
  } satisfies RepositoryWorkflowJob);
  await act(async () => vi.advanceTimersByTimeAsync(5000));

  expect(
    renderer!.root
      .findAllByType("span")
      .some((span) => span.children.includes("Earlier checkpoint")),
  ).toBe(true);
  expect(renderer!.root.findByType("a").children).toContain("Back to run");
  expect(renderer!.root.findByType("a").props.href).toBe("#");
});

it("checks the same push and shows a conflict even when the receipt has no detail", async () => {
  fixture.origin = { ...origin, workflowVmFollowUpGeneration: 3 };
  const receipt = { operationId: "receipt", branch: "launchpad/run", detail: null };
  fixture.push
    .mockResolvedValueOnce({ _tag: "Success", value: { ...receipt, status: "pending" } })
    .mockResolvedValueOnce({ _tag: "Success", value: { ...receipt, status: "conflict" } });
  await mountHeader(null, "done");

  const click = (label: string) =>
    act(async () => {
      const button = renderer!.root
        .findAllByType("button")
        .find((node) => node.children.includes(label));
      expect(button).toBeDefined();
      button!.props.onClick();
    });
  await click("Push");
  await click("Check push");

  expect(fixture.push.mock.calls[1]?.[0].input.operationId).toBe("receipt");
  expect(renderer!.root.findByProps({ role: "alert" }).children).toContain(
    "The workflow branch changed on GitHub.",
  );
});
