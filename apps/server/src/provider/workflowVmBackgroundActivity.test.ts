import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProviderDriverKind, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  makeWorkflowVmBackgroundActivity,
  readWorkflowVmBackgroundRevision,
} from "./workflowVmBackgroundActivity.ts";

it.layer(NodeServices.layer)("finished workflow background activity", (it) => {
  it.effect("retains a fresh quiet revision after raw child or mapped task activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const state = yield* fs.makeTempDirectoryScoped();
        const coordinatorFs = {
          ...fs,
          readFileString: (path: string, encoding?: string) =>
            path === "/proc/self/stat"
              ? Effect.succeed(`42 (coordinator) S ${"0 ".repeat(18)}1234`)
              : fs.readFileString(path, encoding),
        };
        const threadId = ThreadId.make("thread");
        const activity = yield* makeWorkflowVmBackgroundActivity(
          coordinatorFs,
          path,
          state,
          threadId,
        );
        const identity = {
          bootId: "13835087-40ba-45c5-bde6-d0092298eaf5",
          groupId: "a".repeat(32),
          pid: 65,
          startTicks: "5678",
          executableSha256: "a".repeat(64),
        };
        const live = {
          bootId: identity.bootId,
          groups: [{ id: identity.groupId, kind: "provider" }],
        };
        const read = (inventory = live) =>
          readWorkflowVmBackgroundRevision(coordinatorFs, path, state, inventory);
        expect(yield* read()).toBeUndefined();
        yield* activity.observeChildren(false, identity);
        const initial = activity.getQuietRevision();
        expect(initial).toMatch(/^[0-9a-f]{32}$/u);
        expect(yield* read()).toBe(initial);
        yield* activity.observeChildren(true, identity);
        expect(activity.getQuietRevision()).toBeUndefined();
        const task = {
          threadId,
          eventId: EventId.make("task-started"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-11-24T00:00:00Z",
        };
        const taskId = RuntimeTaskId.make("monitor");
        yield* activity.observeTask({ ...task, type: "task.started", payload: { taskId } });
        yield* activity.observeChildren(false, identity);
        expect(yield* read()).toBeUndefined();
        yield* activity.observeTask({
          ...task,
          type: "task.completed",
          payload: { taskId, status: "completed" },
        });
        const settled = activity.getQuietRevision();
        expect(settled).toMatch(/^[0-9a-f]{32}$/u);
        expect(settled).not.toBe(initial);
        expect(yield* read()).toBe(settled);
        expect(yield* read({ ...live, groups: [] })).toBe(settled);
        expect(yield* read({ ...live, bootId: "previous" })).toBeUndefined();
      }),
    ),
  );
});
