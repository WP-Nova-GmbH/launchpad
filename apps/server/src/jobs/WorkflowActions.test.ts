import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { harness, id } from "./WorkflowActions.test-fixture.ts";
it.effect("publishes the pinned commit once and observes completion on replay", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.actions.execute(id, h.io);
    yield* h.actions.execute(id, h.io);
    assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
    const run = yield* h.io.read;
    assert.equal(run.actions![0]!.state, "completed");
    assert.equal(run.preparedHead, "commit");
    assert.isTrue(run.actions![0]!.commands.every((command) => command.stopped));
  }).pipe(Effect.provide(NodeServices.layer)),
);
for (const fault of ["commit-reply", "push-reply"] as const)
  it.effect(`reconciles ${fault} without repeating the effect`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
      yield* h.actions.execute(id, h.io);
      assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
it.effect("does not publish changes introduced by a commit hook", () =>
  Effect.gen(function* () {
    const h = yield* harness("hook");
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    assert.equal(h.counts().pushes, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("blocks unconfirmed ownership until recovery proves stopping", () =>
  Effect.gen(function* () {
    const h = yield* harness("ownership");
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    assert.isFalse(yield* h.actions.recover(h.io));
    assert.isFalse((yield* h.io.read).actions![0]!.commands[0]!.stopped);
    h.recoverAfterBoot();
    assert.isTrue(yield* h.actions.recover(h.io));
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("does not begin Push when Cancel arrives during commit", () =>
  Effect.gen(function* () {
    const h = yield* harness("cancel");
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    assert.equal(h.counts().pushes, 0);
    assert.equal((yield* h.io.read).progress.status, "cancelling");
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const fault of ["none", "pr-reply", "pr-save"] as const)
  it.effect(`recovers PR ${fault} and reuses the same PR across generations`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      yield* h.actions.execute(id, h.io);
      yield* h.beginPr();
      const first = yield* h.actions.execute("pr:0", h.io).pipe(Effect.result);
      assert.equal(first._tag, fault === "none" ? "Success" : "Failure");
      yield* h.actions.execute("pr:0", h.io);
      h.editBody();
      yield* h.beginPr(1);
      yield* h.actions.execute("pr:1", h.io);
      assert.equal(h.prCounts().creates, 1);
      assert.isAbove(h.prCounts().knownRead, 0);
      assert.equal(
        (yield* h.io.read).publication?.pullRequestUrl,
        "https://github.com/acme/repo/pull/17",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
for (const fault of [
  "pr-invisible",
  "pr-marker",
  "pr-closed",
  "pr-truncated",
  "pr-foreign",
] as const)
  it.effect(`never repeats creation after ${fault}`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      yield* h.actions.execute(id, h.io);
      yield* h.beginPr();
      assert.equal((yield* h.actions.execute("pr:0", h.io).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* h.actions.execute("pr:0", h.io).pipe(Effect.result))._tag, "Failure");
      assert.equal(h.prCounts().creates, 1);
      assert.equal(
        (yield* h.io.read).publication?.pullRequestUrl,
        fault === "pr-closed" ? "https://github.com/acme/repo/pull/17" : null,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

for (const fault of ["ownership-no-boot", "ownership-other-host"] as const)
  it.effect(`does not accept reboot recovery with ${fault}`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
      h.recoverAfterBoot();
      assert.isFalse(yield* h.actions.recover(h.io));
      assert.isFalse((yield* h.io.read).actions![0]!.commands[0]!.stopped);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
it.effect("publishes revised rework to the same branch and preserves the job PR binding", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.actions.execute(id, h.io);
    yield* h.beginPr();
    yield* h.actions.execute("pr:0", h.io);
    yield* h.beginRework();
    yield* h.actions.execute("push:1", h.io);
    yield* h.beginPr(1);
    yield* h.actions.execute("pr:1", h.io);
    const run = yield* h.io.read;
    assert.equal(run.publication?.publishedHead, "commit-2");
    assert.equal(run.publication?.pullRequestUrl, "https://github.com/acme/repo/pull/17");
    assert.deepEqual(h.counts(), { commits: 2, pushes: 2 });
    assert.equal(h.prCounts().creates, 1);
    assert.equal(run.actions?.length, 4);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses embedded remote credentials before creating command intent", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.io.update((run) => ({
      ...run,
      publication: { ...run.publication!, remoteUrl: "https://token@github.com/acme/repo.git" },
    }));
    assert.equal((yield* h.actions.execute(id, h.io).pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(h.counts(), { commits: 0, pushes: 0 });
    assert.equal((yield* h.io.read).actions![0]!.commands.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const fault of ["commit-reply", "push-reply", "pr-reply"] as const)
  it.effect(`requested Pause preserves phase reconciliation after ${fault}`, () =>
    Effect.gen(function* () {
      const h = yield* harness(fault);
      let actionId = id;
      if (fault === "pr-reply") {
        yield* h.actions.execute(id, h.io);
        yield* h.beginPr();
        actionId = "pr:0";
      }
      assert.equal((yield* h.actions.execute(actionId, h.io).pipe(Effect.result))._tag, "Failure");
      yield* h.io.update((run) => ({
        ...run,
        manualPause: { state: "requested", promptId: "reserved-action" },
      }));
      const before = (yield* h.io.read).actions!.find((action) => action.actionId === actionId)!;
      yield* h.actions.execute(actionId, h.io);
      const run = yield* h.io.read;
      const completed = run.actions!.find((action) => action.actionId === actionId)!;
      assert.equal(completed.state, "completed");
      assert.equal(completed.generation, before.generation);
      assert.equal(completed.prBody, before.prBody);
      assert.equal(completed.commitMessage, before.commitMessage);
      assert.equal(run.manualPause?.state, "requested");
      assert.deepEqual(h.counts(), { commits: 1, pushes: 1 });
      assert.equal(h.prCounts().creates, fault === "pr-reply" ? 1 : 0);
      assert.isTrue(
        run.actions!.every((action) => action.commands.every((command) => command.stopped)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
