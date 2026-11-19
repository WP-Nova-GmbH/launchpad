import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { exportWorkflowCodexConversation } from "./WorkflowCodexConversation.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const nativeId = "01900000-0000-7000-8000-000000000001";

it.layer(NodeServices.layer)("Workflow native conversation export", (it) => {
  for (const graph of [false, true])
    it.effect(
      `exports private ${graph ? "multi-step" : "standalone"} history and referenced bytes without copying credentials`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const raw = yield* ChildProcessSpawner.ChildProcessSpawner;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          const home = path.join(root, "private-home");
          const directory = path.join(home, "sessions", "2026", "10", "01");
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.makeDirectory(path.join(home, "native-files"));
          const image = path.join(home, "native-files", "image.png");
          yield* fs.writeFile(image, new Uint8Array([137, 80, 78, 71, 0, 1]));
          const rollout = path.join(directory, `rollout-2026-10-01T12-00-00-${nativeId}.jsonl`);
          let text =
            encode({
              type: "session_meta",
              payload: { id: nativeId, cli_version: "0.159.3", history_mode: "paginated" },
            }) +
            "\n" +
            encode({
              type: "event_msg",
              payload: { type: "user_message", local_images: [image], message: "image" },
            }) +
            "\n" +
            encode({
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "final answer" }],
              },
            }) +
            "\n";
          let head = rollout;
          let prefix: string | undefined;
          if (graph) {
            const row = (ordinal: number, type: string, payload: unknown) =>
              encode({ ordinal, type, payload }) + "\n";
            const metadata = {
              id: nativeId,
              session_id: nativeId,
              cli_version: "0.159.3",
              history_mode: "paginated",
            };
            prefix =
              row(0, "session_meta", metadata) +
              row(1, "event_msg", {
                type: "user_message",
                local_images: [image],
                message: "image",
              }) +
              row(2, "response_item", {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "first result" }],
              });
            yield* fs.writeFileString(
              rollout,
              prefix + row(3, "response_item", { type: "message", content: ["discarded tail"] }),
            );
            head = rollout.replace(
              `${nativeId}.jsonl`,
              `${nativeId}_01900000-0000-7000-8000-000000000003.jsonl`,
            );
            text =
              row(3, "session_meta", {
                ...metadata,
                history_base: {
                  thread_id: nativeId,
                  end_ordinal_exclusive: 3,
                  end_byte_offset: Buffer.byteLength(prefix),
                },
              }) +
              row(4, "response_item", {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "second result" }],
              });
          }
          yield* fs.writeFileString(head, text);
          yield* fs.writeFileString(
            path.join(home, "auth.json"),
            "private-credential-must-not-copy",
          );
          const unrelated = path.join(
            directory,
            "rollout-2026-10-01T12-00-00-01900000-0000-7000-8000-000000000002.jsonl",
          );
          yield* fs.writeFileString(
            unrelated,
            encode({
              type: "session_meta",
              payload: { id: "01900000-0000-7000-8000-000000000002" },
            }) + "\n",
          );
          const denied = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "realPath",
          });
          const coordinatorFs: FileSystem.FileSystem = {
            ...fs,
            realPath: (file) =>
              file === home || file.startsWith(home + path.sep)
                ? Effect.fail(denied)
                : fs.realPath(file),
          };
          const reader = path.resolve(
            import.meta.dirname,
            "../../../../../infra/e2b/template/workflow-checkpoint-reader.py",
          );
          const spawner = ChildProcessSpawner.make((command) => {
            if (ChildProcess.isPipedCommand(command)) return raw.spawn(command);
            const args = command.args.map((arg) =>
              arg === "/opt/launchpad/bin/launchpad-workflow-checkpoint-reader.py" ? reader : arg,
            );
            return raw.spawn(ChildProcess.make(command.command, args, command.options));
          });
          const artifactRoot = path.join(root, "artifacts");
          const archive = yield* exportWorkflowCodexConversation(spawner, {
            codexHome: home,
            rolloutPath: head,
            threadId: nativeId,
            artifactRoot,
          }).pipe(Effect.provideService(FileSystem.FileSystem, coordinatorFs));
          expect(yield* fs.readFileString(path.join(archive.directory, "rollout.jsonl"))).toBe(
            text,
          );
          if (graph) {
            expect(archive.manifest.format).toBe("codex-rollout-v3");
            expect(archive.manifest.rollouts).toHaveLength(2);
            expect(
              yield* fs.readFileString(
                path.join(archive.directory, "native-rollouts", path.basename(rollout)),
              ),
            ).toBe(prefix);
          }
          expect(archive.manifest.files).toHaveLength(1);
          const file = archive.manifest.files![0]!;
          expect(file.sourcePath).toBe(image);
          expect(
            Array.from(yield* fs.readFile(path.join(archive.directory, "files", file.name))),
          ).toEqual([137, 80, 78, 71, 0, 1]);
          expect(yield* fs.readDirectory(artifactRoot)).toHaveLength(1);
          expect(yield* fs.exists(path.join(archive.directory, "auth.json"))).toBe(false);
          expect(yield* fs.readFileString(path.join(home, "auth.json"))).toBe(
            "private-credential-must-not-copy",
          );
        }),
    );
});
