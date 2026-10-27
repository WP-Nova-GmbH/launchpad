import { describe, expect, it, vi } from "@effect/vitest";
import {
  type OrchestrationProject,
  ProjectId,
  TerminalProcessExitError,
  type TerminalEvent,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { SetupProcessJournal, SetupProcessError } from "../terminal/SetupProcessJournal.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadSubscriptionAnchor: () => Effect.succeedNone,
    getUserInputActivity: () => Effect.die("unused"),
    listActivitiesByKind: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getDeletedWorktreeThreads: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShells: () => Effect.die("unused"),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getImportedAgentSessionSources: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getTurnStartMessage: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

type TerminalOverrides = Pick<TerminalManager.TerminalManager["Service"], "open" | "write"> &
  Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe" | "writeSetup">>;

const makeTerminalManagerLayer = (overrides: TerminalOverrides) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    captureCleanup: () => Effect.die("unused"),
    writeSetup: () => Effect.die("unexpected setup write"),
    deleteHistory: () => Effect.void,
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    closeOwned: () => Effect.succeed(false),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
    ...overrides,
  });

const testLayer = (
  project: OrchestrationProject,
  terminal: TerminalOverrides,
  settings = ServerSettings.layerTest(),
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
    Layer.provide(settings),
  );

describe("ProjectSetupScriptRunner", () => {
  it.effect("runs the inherited machine setup action in the checkout's worktree", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-default-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toMatchObject({ status: "started", scriptId: "default-setup" });
      expect(open).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      });
      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        data: "npm install\r",
      });
    }).pipe(
      Effect.provide(
        testLayer(
          makeProject([]),
          { open, write },
          ServerSettings.layerTest({
            defaultProjectScripts: [
              {
                id: "default-setup",
                name: "Setup",
                command: "npm install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
          }),
        ),
      ),
    );
  });

  it.effect("returns no-script when no setup script exists", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect(
    "opens the deterministic setup terminal with worktree env and writes the command",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        });

        expect(result).toEqual({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "bun install",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          async: true,
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          },
        });
        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: "bun install\r",
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

  it.effect(
    "wraps the command with a completion sentinel and resolves the exit code from terminal output",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const writes: string[] = [];
      const write = vi.fn((input: { data: string }) =>
        Effect.sync(() => void writes.push(input.data)),
      );
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
        listener = next;
        return Effect.succeed(() => {
          listener = null;
        });
      });
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);
      const emit = (data: string) =>
        Effect.suspend(() =>
          listener
            ? listener({ threadId: "thread-1", terminalId: "setup-setup", type: "output", data })
            : Effect.void,
        );

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const seen: string[] = [];
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {
            onOutputLine: (line) => Effect.sync(() => void seen.push(line)),
          },
        });
        expect(result.status).toBe("started");
        if (result.status !== "started") return;
        expect(result.completion).toBeDefined();

        // The subscription is attached before the command is written.
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(writes).toHaveLength(1);
        // The block closes on its own line so a trailing comment in the
        // command cannot swallow the sentinel, and the sentinel carries a
        // per-run token so script output cannot spoof it.
        const written = writes[0] ?? "";
        const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
        expect(sentinel).toBeDefined();
        expect(written).toBe(`( bun install\r); printf '\\n${sentinel}%s\\n' "$?"\r`);

        // Output arrives in chunks; partial lines are buffered until a newline,
        // control sequences are stripped, and the echoed wrapper is hidden.
        yield* emit(`( bun install\r\n> ); printf '\\n${sentinel}%s\\n' "$?"\r\n`);
        yield* emit("\u001b[32mResolving");
        yield* emit(" deps\u001b[0m\r\n");
        // Progress redraws separated by bare carriage returns are their own lines.
        yield* emit("Progress: 1/3\rProgress: 2/3\rProgress: 3/3\r\nDone in 2s\r\n");
        // A spoofed sentinel from the script itself must not settle completion.
        yield* emit("__T3_SETUP_DONE__:0\r\n");
        yield* emit(`__T3_SETUP_DONE___${"0".repeat(32)}:0\r\n`);
        yield* emit(`${sentinel}3\r\n`);

        // The observer also releases itself when its caller has not started awaiting yet.
        expect(listener).toBeNull();
        const completion = yield* result.completion!;
        expect(completion.exitCode).toBe(3);
        expect(seen).toEqual([
          "Resolving deps",
          "Progress: 1/3",
          "Progress: 2/3",
          "Progress: 3/3",
          "Done in 2s",
          "__T3_SETUP_DONE__:0",
          `__T3_SETUP_DONE___${"0".repeat(32)}:0`,
        ]);
        // The subscription is torn down once the sentinel arrives.
        expect(listener).toBeNull();
      }).pipe(
        Effect.provide(testLayer(project, { open, write, subscribe })),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/zsh" }),
      );
    },
  );

  it.effect("unsubscribes from terminal output when the command cannot be written", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() =>
      Effect.fail(
        new TerminalManager.TerminalCwdStatError({ cwd: "/repo/worktrees/a", cause: {} }),
      ),
    );
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => Effect.succeed(unsubscribe));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {},
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer(project, { open, write, subscribe })));
  });

  it.effect.each([
    {
      shell: "/usr/bin/fish",
      expected:
        /^begin\rbun install\rend; printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' \$status\r$/,
    },
    {
      shell: "/bin/bash",
      expected: /^\( bun install\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
    },
  ])("wraps the command for the $shell syntax", ({ shell, expected }) => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const writes: string[] = [];
    const write = vi.fn((input: { data: string }) =>
      Effect.sync(() => void writes.push(input.data)),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(expected);
    }).pipe(
      Effect.provide(testLayer(project, { open, write })),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { SHELL: shell }),
    );
  });

  it.effect.each([true, false])(
    "retains the wait policy when launching a script fails (async=%s)",
    (async) => {
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "false",
          icon: "configure",
          runOnWorktreeCreate: true,
          async,
        },
      ]);
      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const error = yield* runner
          .runForThread({
            threadId: "thread-1",
            projectId: "project-1",
            worktreePath: "/repo/worktrees/a",
          })
          .pipe(Effect.flip);
        expect(isProjectSetupScriptOperationError(error) && error.waitForCompletion).toBe(!async);
      }).pipe(
        Effect.provide(
          testLayer(project, {
            open: () =>
              Effect.fail(
                new TerminalManager.TerminalCwdStatError({
                  cwd: "/repo/worktrees/a",
                  cause: "missing",
                }),
              ),
            write: () => Effect.die("unexpected write"),
          }),
        ),
      );
    },
  );

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });
});

it.effect("a managed setup never writes its command if birth identity persistence fails", () => {
  const write = vi.fn(() => Effect.void);
  const open = () =>
    Effect.succeed({
      threadId: "thread-1",
      terminalId: "setup-attempt",
      cwd: "/repo/worktrees/a",
      worktreePath: "/repo/worktrees/a",
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Setup",
      updatedAt: "2026-10-09T00:00:00Z",
    });
  const project = makeProject([
    {
      id: "setup",
      name: "Setup",
      command: "preview",
      icon: "configure",
      runOnWorktreeCreate: true,
    },
  ]);
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const error = yield* Effect.flip(
      runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
        preferredTerminalId: "setup-attempt",
        preparationAttemptId: "attempt",
      }),
    );
    expect(error).toMatchObject({ operation: "recordProcess" });
    expect(write).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      testLayer(project, { open, write }).pipe(
        Layer.provide(
          Layer.succeed(SetupProcessJournal, {
            owners: () => Effect.succeed([]),
            launcher: Effect.succeed("/native/helper"),
            confirmed: () => Effect.succeed(false),
            begin: () => Effect.void,
            capture: () =>
              Effect.fail(new SetupProcessError({ message: "Identity could not be saved" })),
            complete: () => Effect.void,
            cleanup: () => Effect.fail(new SetupProcessError({ message: "Not used" })),
            recover: () => Effect.fail(new SetupProcessError({ message: "Not used" })),
          }),
        ),
      ),
    ),
  );
});

for (const selected of [
  "/usr/bin/fish",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "cmd.exe",
  "exited-before-arm-ack",
] as const) {
  it.effect(`uses the acknowledged setup shell and rejects unsafe delivery: ${selected}`, () =>
    Effect.gen(function* () {
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);
      const writes: string[] = [];
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;
      const terminalId = "setup-attempt";
      const layer = testLayer(project, {
        open: () =>
          Effect.succeed({
            threadId: "thread-1",
            terminalId,
            cwd: "/repo/worktrees/a",
            worktreePath: "/repo/worktrees/a",
            status: "running",
            pid: 123,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: terminalId,
            updatedAt: "now",
          }),
        write: () => Effect.die("unexpected ordinary write"),
        writeSetup: ({ data }) =>
          Effect.sync(() => {
            writes.push(data);
          }),
        subscribe: (callback) =>
          Effect.sync(() => {
            listener = callback;
            return () => {
              listener = undefined;
            };
          }),
      }).pipe(
        Layer.provide(
          Layer.succeed(SetupProcessJournal, {
            ...SetupProcessJournal.defaultValue(),
            launcher: Effect.succeed("/helper"),
            capture: () =>
              Effect.gen(function* () {
                expect(listener).toBeDefined();
                if (selected === "exited-before-arm-ack") {
                  yield* listener!({
                    type: "exited",
                    threadId: "thread-1",
                    terminalId,
                    sequence: 1,
                    exitCode: 7,
                    exitSignal: null,
                  });
                  return "/bin/sh";
                }
                return selected;
              }),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner
          .runForThread({
            threadId: "thread-1",
            projectId: "project-1",
            worktreePath: "/repo/worktrees/a",
            preparationAttemptId: "attempt",
            preferredTerminalId: terminalId,
            observeCompletion: {},
          })
          .pipe(Effect.result);
        if (selected === "cmd.exe" || selected === "exited-before-arm-ack") {
          expect(result._tag).toBe("Failure");
          expect(writes).toEqual([]);
        } else {
          expect(result._tag).toBe("Success");
          expect(writes[0]).toContain(
            selected === "/usr/bin/fish" ? "begin\rbun install\rend" : "$global:LASTEXITCODE",
          );
        }
      }).pipe(Effect.provide(layer));
    }),
  );
}

it.effect(
  "restarting the setup terminal ends the old setup wait without replaying the script",
  () =>
    Effect.gen(function* () {
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);
      const writes: string[] = [];
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;
      const terminalId = "setup";
      const layer = testLayer(project, {
        open: () =>
          Effect.succeed({
            threadId: "thread-1",
            terminalId,
            cwd: "/repo/worktrees/a",
            worktreePath: "/repo/worktrees/a",
            status: "running",
            pid: 123,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: terminalId,
            updatedAt: "now",
          }),
        write: ({ data }) =>
          Effect.sync(() => {
            writes.push(data);
          }),
        subscribe: (callback) =>
          Effect.sync(() => {
            listener = callback;
            return () => {
              listener = undefined;
            };
          }),
      });
      yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
          preferredTerminalId: terminalId,
          observeCompletion: {},
        });
        expect(result.status).toBe("started");
        if (result.status !== "started") return;
        yield* listener!({
          type: "restarted",
          threadId: "thread-1",
          terminalId,
          sequence: 1,
          snapshot: {
            threadId: "thread-1",
            terminalId,
            cwd: "/repo/worktrees/a",
            worktreePath: "/repo/worktrees/a",
            status: "running",
            pid: 456,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: terminalId,
            updatedAt: "now",
          },
        });
        expect((yield* result.completion!).exitCode).toBeNull();
        expect(writes).toHaveLength(1);
        expect(listener).toBeUndefined();
      }).pipe(Effect.provide(layer));
    }),
);

const managedSnapshot = {
  threadId: "thread-1",
  terminalId: "setup-attempt",
  cwd: "/repo/worktrees/a",
  worktreePath: "/repo/worktrees/a",
  status: "running" as const,
  pid: 123,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "setup-attempt",
  updatedAt: "now",
};
const armedJournal = {
  ...SetupProcessJournal.defaultValue(),
  launcher: Effect.succeed("/helper"),
  capture: () => Effect.succeed("/bin/sh"),
};

it.effect.each([
  [false, true],
  [false, false],
  [true, true],
  [true, false],
] as const)(
  "guarded delivery failure retains its policy and releases observation (async=%s observe=%s)",
  ([async, observe]) =>
    Effect.gen(function* () {
      const project = makeProject([]);
      const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
      const write = vi.fn(() => Effect.void);
      const layer = testLayer(project, {
        open: () => Effect.succeed(managedSnapshot),
        write,
        writeSetup: () =>
          Effect.fail(
            new TerminalProcessExitError({
              threadId: "thread-1",
              terminalId: "setup-attempt",
              terminalPid: 123,
              detail: "Setup owner was replaced",
            }),
          ),
        subscribe: (listener) =>
          Effect.sync(() => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          }),
      });
      yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const failure = yield* runner
          .runForThread({
            threadId: "thread-1",
            projectId: "project-1",
            worktreePath: "/repo/worktrees/a",
            preparationAttemptId: "attempt",
            preferredTerminalId: "setup-attempt",
            ...(observe ? { observeCompletion: {} } : {}),
            resolvedScript: { id: "setup", name: "Setup", command: "echo SIDE_EFFECT", async },
          })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          operation: "writeCommand",
          waitForCompletion: !async,
          cause: { _tag: "TerminalProcessExitError" },
        });
        expect(write).not.toHaveBeenCalled();
        expect(listeners.size).toBe(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provideService(SetupProcessJournal, armedJournal)),
);

it.effect("interrupted guarded delivery releases its completion observer without fallback", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const write = vi.fn(() => Effect.void);
    const layer = testLayer(makeProject([]), {
      open: () => Effect.succeed(managedSnapshot),
      write,
      writeSetup: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      subscribe: (listener) =>
        Effect.sync(() => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const pending = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
          preparationAttemptId: "attempt",
          preferredTerminalId: "setup-attempt",
          observeCompletion: {},
          resolvedScript: { id: "setup", name: "Setup", command: "echo SIDE_EFFECT", async: false },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(listeners.size).toBe(1);
      yield* Fiber.interrupt(pending);
      expect(listeners.size).toBe(0);
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provideService(SetupProcessJournal, armedJournal)),
);
