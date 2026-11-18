import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { CodexConversationManifest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { verifyRestoredWorkflowNativeHome } from "./ThreadVmWorkflowRestore.ts";
import { workflowVmBaseEnvironment } from "../vmWorkloadCommand.ts";

const sha = (bytes: string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

it.effect(
  "verifies the saved Codex heads and historical prefixes in the restored workflow home",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const raw = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped();
        const reader = path.resolve(
          import.meta.dirname,
          "../../../../infra/e2b/template/workflow-checkpoint-reader.py",
        );
        const spawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected command");
          expect(command.command).toBe("/usr/bin/python3");
          expect(command.options.cwd).toBe(workflowVmBaseEnvironment.CODEX_HOME);
          expect(command.args).toEqual([
            "-IS",
            "/opt/launchpad/bin/launchpad-workflow-checkpoint-reader.py",
            "capture",
          ]);
          return raw.spawn(
            ChildProcess.make(command.command, ["-IS", reader, "capture"], {
              ...command.options,
              cwd: home,
            }),
          );
        });
        const rootId = "01900000-0000-7000-8000-000000000001";
        const rootName = `rollout-2026-11-11T10-00-00-${rootId}.jsonl`;
        const prefixName = "rollout-2026-11-10T10-00-00-01900000-0000-7000-8000-000000000002.jsonl";
        const root = "complete saved conversation";
        const prefix = "retained native history prefix";
        const current = path.join(home, "sessions", "2026", "11", "11", rootName);
        const archived = path.join(home, "archived_sessions", prefixName);
        yield* fs.makeDirectory(path.dirname(current), { recursive: true });
        yield* fs.makeDirectory(path.dirname(archived), { recursive: true });
        yield* fs.writeFileString(current, root);
        yield* fs.writeFileString(archived, prefix + " original native tail");
        const manifest: CodexConversationManifest = {
          format: "codex-rollout-v3",
          codexVersion: "0.159.3",
          historyMode: "paginated",
          threadId: rootId,
          rolloutName: rootName,
          sha256: sha(root),
          heads: { [rootId]: rootName },
          rollouts: [
            { rolloutName: rootName, sizeBytes: Buffer.byteLength(root), sha256: sha(root) },
            { rolloutName: prefixName, sizeBytes: Buffer.byteLength(prefix), sha256: sha(prefix) },
          ],
        };
        const verify = verifyRestoredWorkflowNativeHome(manifest, home).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* verify;
        yield* fs.writeFileString(current, root + " changed");
        yield* Effect.flip(verify);
        yield* fs.remove(current);
        yield* Effect.flip(verify);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
