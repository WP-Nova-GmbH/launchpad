import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type ThreadQueueEntry,
} from "@t3tools/contracts";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import * as Effect from "effect/Effect";
import { validateThreadQueueProviders } from "./ThreadQueueProviders.ts";

const model = (id: string) => ({ instanceId: ProviderInstanceId.make(id), model: "test-model" });
const common = {
  revision: 1,
  acceptedSequence: 1,
  createdAt: "2026-10-05T00:00:00.000Z",
  state: "pending" as const,
};
const prompt = (id: string): ThreadQueueEntry => ({
  ...common,
  messageId: MessageId.make(id),
  kind: "prompt",
  text: "continue",
  attachments: [],
  runtimeMode: "full-access",
  interactionMode: "default",
  modelSelection: model(id),
});
const vm: ThreadQueueEntry = {
  ...common,
  kind: "move",
  messageId: MessageId.make("to-vm"),
  destination: { kind: "vm" },
};
const local: ThreadQueueEntry = {
  ...common,
  kind: "move",
  messageId: MessageId.make("to-local"),
  destination: {
    kind: "environment",
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project"),
  },
};
const validate = (entries: readonly ThreadQueueEntry[], onVm = false, current = "codex") =>
  validateThreadQueueProviders(
    { modelSelection: model(current), promptQueue: { ...emptyThreadPromptQueue(), entries } },
    onVm,
    "thread.queue.reorder",
    (id) => Effect.succeed(id === "custom-codex" || id === "codex"),
  );

it.effect("allows ordinary queues without a VM-compatible provider", () =>
  Effect.gen(function* () {
    yield* validate([prompt("claude")], false, "claude");
  }),
);
it.effect("validates every effective VM segment, including multiple moves", () =>
  Effect.gen(function* () {
    yield* validate([vm, prompt("codex"), local, prompt("custom-codex")]);
    yield* validate([local, prompt("claude")], true);
    for (const entries of [
      [vm, prompt("claude")],
      [prompt("claude"), vm],
      [vm, local, prompt("claude"), vm],
    ])
      expect((yield* Effect.flip(validate(entries)))._tag).toBe(
        "OrchestrationCommandInvariantError",
      );
  }),
);
it.effect("keeps named Codex transfers and prompts on ordinary environments supported", () =>
  Effect.gen(function* () {
    yield* validate([local, prompt("custom-codex"), local], false, "custom-codex");
    yield* validate([local, prompt("custom-codex")], true);
  }),
);
it.effect("rejects named instances before entering or executing on a VM", () =>
  Effect.gen(function* () {
    for (const [entries, onVm, current] of [
      [[vm], false, "custom-codex"],
      [[local, vm], false, "custom-codex"],
      [[prompt("custom-codex"), vm], false, "codex"],
      [[vm, prompt("custom-codex")], false, "codex"],
      [[vm, local, prompt("custom-codex"), vm], false, "codex"],
      [[local], true, "custom-codex"],
    ] as const)
      expect((yield* Effect.flip(validate(entries, onVm, current))).detail).toBe(
        "Private VMs currently require the default Codex provider.",
      );
  }),
);
it.effect("does not treat a default instance ID as evidence of a supported driver", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      validateThreadQueueProviders(
        {
          modelSelection: model("codex"),
          promptQueue: { ...emptyThreadPromptQueue(), entries: [vm] },
        },
        false,
        "thread.move.enqueue",
        () => Effect.succeed(false),
      ),
    );
    expect(failure._tag).toBe("OrchestrationCommandInvariantError");
  }),
);
it.effect("rejects incompatible or unavailable current native state before a move", () =>
  Effect.gen(function* () {
    expect((yield* Effect.flip(validate([vm], false, "disabled")))._tag).toBe(
      "OrchestrationCommandInvariantError",
    );
    expect((yield* Effect.flip(validate([local], true, "claude")))._tag).toBe(
      "OrchestrationCommandInvariantError",
    );
  }),
);
it.effect("checks an instance once per ordered validation", () =>
  Effect.gen(function* () {
    const checked: string[] = [];
    yield* validateThreadQueueProviders(
      {
        modelSelection: model("custom-codex"),
        promptQueue: {
          ...emptyThreadPromptQueue(),
          entries: [local, prompt("codex"), vm, local, vm, prompt("codex")],
        },
      },
      false,
      "thread.queue.reorder",
      (id) =>
        Effect.sync(() => {
          checked.push(id);
          return true;
        }),
    );
    expect(checked).toEqual(["custom-codex", "codex"]);
  }),
);
