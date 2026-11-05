import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ list: vi.fn(), events: vi.fn() }));
vi.mock("~/state/preview", () => ({ previewEnvironment: mocks }));

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { usePreviewSession } from "./usePreviewSession";

let renderer: ReactTestRenderer | undefined;
let testId = 0;
let releases: Array<() => void> = [];

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function Harness({ threadRef }: { threadRef: ScopedThreadRef }) {
  usePreviewSession(threadRef);
  return null;
}

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function fixture() {
  const threadRef = {
    environmentId: EnvironmentId.make(`preview-sync-environment-${++testId}`),
    threadId: ThreadId.make(`preview-sync-thread-${testId}`),
  };
  const snapshot: PreviewSessionSnapshot = {
    threadId: threadRef.threadId,
    tabId: "one-time-preview",
    navStatus: {
      _tag: "Loading",
      url: "http://owned.preview.localhost:18610/__launchpad_preview/#one-time-ticket",
      title: "",
    },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-10-20T12:00:00.000Z",
  };
  const requests: Array<ReturnType<typeof deferred<PreviewListResult>>> = [];
  const list = Atom.make(
    Effect.promise(() => {
      const request = deferred<PreviewListResult>();
      requests.push(request);
      return request.promise;
    }),
  ).pipe(Atom.swr({ staleTime: 5_000, revalidateOnMount: true }));
  mocks.list.mockReturnValue(list);
  mocks.events.mockReturnValue(Atom.make(AsyncResult.initial<PreviewEvent>()));
  return { threadRef, snapshot, requests, list };
}

async function mount(threadRef: ScopedThreadRef) {
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <Harness threadRef={threadRef} />
      </AppAtomRegistryProvider>,
    );
    await flushEffects();
  });
}

beforeEach(() => {
  resetPreviewStateForTests();
  mocks.list.mockReset();
  mocks.events.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const release of releases) release();
  releases = [];
});

describe("preview session hydration", () => {
  it("starts an unread SWR list and hydrates its first server epoch", async () => {
    const { threadRef, snapshot, requests } = fixture();
    applyPreviewServerSnapshot(threadRef, snapshot);
    await mount(threadRef);
    expect(requests.length).toBeGreaterThan(0);
    const refreshedRequest = requests.at(-1)!;

    await act(async () => {
      refreshedRequest.resolve({ sessions: [snapshot], serverEpoch: "guest-process", revision: 1 });
      await flushEffects();
    });

    expect(readThreadPreviewState(threadRef).serverEpoch).toBe("guest-process");
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);

    await act(async () => {
      for (const request of requests) {
        if (request !== refreshedRequest) {
          request.resolve({ sessions: [], serverEpoch: "guest-process", revision: 0 });
        }
      }
      await flushEffects();
    });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
  });

  it("preserves an optimistic one-time tab while a cached empty list revalidates", async () => {
    const { threadRef, snapshot, requests, list } = fixture();
    releases.push(appAtomRegistry.mount(list));
    await flushEffects();
    expect(requests).toHaveLength(1);
    requests[0]!.resolve({ sessions: [], serverEpoch: "guest-process", revision: 0 });
    await flushEffects();
    expect(AsyncResult.isSuccess(appAtomRegistry.get(list))).toBe(true);

    applyPreviewServerSnapshot(threadRef, snapshot);
    await mount(threadRef);
    expect(requests).toHaveLength(2);
    expect(readThreadPreviewState(threadRef).serverEpoch).toBeNull();
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);

    await act(async () => {
      requests[1]!.resolve({ sessions: [snapshot], serverEpoch: "guest-process", revision: 1 });
      await flushEffects();
    });

    expect(readThreadPreviewState(threadRef).serverEpoch).toBe("guest-process");
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
  });
});
