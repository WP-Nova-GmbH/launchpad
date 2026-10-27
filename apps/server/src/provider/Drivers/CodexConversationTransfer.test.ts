import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { exportCodexConversation, importCodexConversation } from "./CodexConversationTransfer.ts";
import { parseCodexNativeRollout } from "./CodexNativeHistory.ts";

const nativeId = "01900000-0000-7000-8000-000000000001";
const version = "0.159.3";
const newerVersion = "0.163.0-alpha.10.2";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-transfer-test-" });
  const home = path.join(root, "source");
  const dir = path.join(home, "sessions", "2026", "10", "01");
  yield* fs.makeDirectory(dir, { recursive: true });
  const rolloutPath = path.join(dir, `rollout-2026-10-01T12-00-00-${nativeId}.jsonl`);
  const contents =
    encodeJson({
      type: "session_meta",
      payload: { id: nativeId, cli_version: version, history_mode: "paginated" },
    }) +
    '\n{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"remember amber-otter"}]}}\n';
  yield* fs.writeFileString(rolloutPath, contents);
  yield* fs.writeFileString(path.join(home, "auth.json"), "test-login-must-not-transfer");
  yield* fs.writeFileString(path.join(dir, "unrelated.jsonl"), "another private conversation");
  const input = {
    codexHome: home,
    rolloutPath,
    threadId: nativeId,
    artifactRoot: path.join(root, "artifacts"),
  };
  return { fs, path, root, home, rolloutPath, contents, input };
});

const referencedFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const root = yield* f.fs.realPath(f.root);
  const filesRoot = f.path.join(root, "thread-files");
  yield* f.fs.makeDirectory(filesRoot);
  const image = f.path.join(filesRoot, "image.png");
  const audio = f.path.join(filesRoot, "audio.wav");
  yield* f.fs.writeFile(image, new Uint8Array([137, 80, 78, 71, 0, 1]));
  yield* f.fs.writeFile(audio, new Uint8Array([82, 73, 70, 70, 1, 2]));
  const event = {
    timestamp: "2026-10-01T12:00:01Z",
    type: "event_msg",
    another_field: "keep this",
    payload: {
      type: "user_message",
      message: image,
      local_images: [image],
      local_audio: [audio],
      file_ids: [],
      other: { preserve: true },
    },
  };
  yield* f.fs.writeFileString(f.rolloutPath, f.contents + encodeJson(event) + "\n");
  return {
    ...f,
    filesRoot,
    image,
    audio,
    event,
    input: { ...f.input, referencedFileRoots: [filesRoot] },
  };
});

const childNativeId = "01900000-0000-7000-8000-000000000002";
const revertedNativeId = "01900000-0000-7000-8000-000000000003";
const graphFixture = Effect.gen(function* () {
  const f = yield* referencedFixture;
  const row = (ordinal: number, type: string, payload: unknown) =>
    encodeJson({ timestamp: "2026-10-01T12:00:00Z", ordinal, type, payload }) + "\n";
  const meta = {
    id: nativeId,
    session_id: nativeId,
    cli_version: version,
    history_mode: "paginated",
  };
  const prefix =
    row(0, "session_meta", meta) +
    row(1, "event_msg", {
      type: "user_message",
      local_images: [f.image],
      message: "keep this",
      file_ids: [],
    }) +
    row(2, "response_item", {
      type: "function_call",
      name: "spawn_agent",
      call_id: "child-create",
      arguments: "opaque",
    }) +
    row(3, "response_item", {
      type: "function_call_output",
      call_id: "child-create",
      output: encodeJson({ task_name: "/root/child" }),
    });
  yield* f.fs.writeFileString(
    f.rolloutPath,
    prefix + row(4, "response_item", { type: "message", content: ["removed native tail"] }),
  );
  const head = f.rolloutPath.replace(`${nativeId}.jsonl`, `${nativeId}_${revertedNativeId}.jsonl`);
  yield* f.fs.writeFileString(
    head,
    row(4, "session_meta", {
      ...meta,
      history_base: {
        thread_id: nativeId,
        end_ordinal_exclusive: 4,
        end_byte_offset: Buffer.byteLength(prefix),
      },
    }) + row(5, "response_item", { type: "message", content: ["same native root"] }),
  );
  const child = f.rolloutPath.replace(nativeId, childNativeId);
  yield* f.fs.writeFileString(
    child,
    row(0, "session_meta", {
      ...meta,
      id: childNativeId,
      parent_thread_id: nativeId,
      forked_from_id: nativeId,
      agent_path: "/root/child",
      subagent_history_start_ordinal: 1,
    }) +
      row(1, "event_msg", {
        type: "user_message",
        local_images: [f.image],
        message: "same child",
        file_ids: [],
      }),
  );
  return { ...f, head, child, prefix, input: { ...f.input, rolloutPath: head } };
});

it.layer(NodeServices.layer)("Codex conversation transfer", (it) => {
  it.effect(
    "transfers a reverted native root and existing child, repairing image-prefix byte offsets",
    () =>
      Effect.gen(function* () {
        const f = yield* graphFixture;
        const exported = yield* exportCodexConversation(f.input);
        expect(exported.manifest.format).toBe("codex-rollout-v3");
        expect(exported.manifest.rollouts).toHaveLength(3);
        expect(exported.manifest.files).toHaveLength(1);
        expect(exported.manifest.heads).toEqual({
          [nativeId]: f.path.basename(f.head),
          [childNativeId]: f.path.basename(f.child),
        });
        const artifactPrefix = yield* f.fs.readFileString(
          f.path.join(exported.directory, "native-rollouts", f.path.basename(f.rolloutPath)),
        );
        expect(artifactPrefix).toBe(f.prefix);
        expect(artifactPrefix).not.toContain("removed native tail");
        yield* f.fs.remove(f.home, { recursive: true });
        const imported = yield* importCodexConversation({
          manifest: exported.manifest,
          rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
          destinationRoot: f.path.join(f.root, "destination"),
          codexVersion: version,
        });
        expect(imported.resumeCursor).toEqual({
          threadId: nativeId,
          resumePolicy: "require-existing",
        });
        expect(yield* f.fs.exists(f.path.join(imported.homePath, "auth.json"))).toBe(false);
        const head = yield* decodeJson(
          (yield* f.fs.readFileString(imported.rolloutPath)).split("\n")[0],
        );
        const prefixPath = f.path.join(
          f.path.dirname(imported.rolloutPath),
          f.path.basename(f.rolloutPath),
        );
        const relocated = yield* f.fs.readFileString(prefixPath);
        expect(head).toMatchObject({
          ordinal: 4,
          payload: {
            id: nativeId,
            history_base: {
              thread_id: nativeId,
              end_ordinal_exclusive: 4,
              end_byte_offset: Buffer.byteLength(relocated),
            },
          },
        });
        expect(relocated).toContain(imported.homePath);
        const second = yield* exportCodexConversation({
          ...f.input,
          codexHome: imported.homePath,
          rolloutPath: imported.rolloutPath,
          artifactRoot: f.path.join(f.root, "second"),
        });
        expect(second.manifest.heads).toEqual(exported.manifest.heads);
        expect(second.manifest.rollouts).toHaveLength(3);
      }),
  );

  it.effect("preserves mixed source versions while transferring a native history graph", () =>
    Effect.gen(function* () {
      const f = yield* graphFixture;
      yield* f.fs.writeFileString(
        f.head,
        (yield* f.fs.readFileString(f.head)).replace(version, newerVersion),
      );
      yield* f.fs.writeFileString(
        f.child,
        (yield* f.fs.readFileString(f.child)).replace(version, "0.160.0"),
      );
      const exported = yield* exportCodexConversation(f.input);
      expect(exported.manifest.codexVersion).toBe(newerVersion);
      const imported = yield* importCodexConversation({
        manifest: exported.manifest,
        rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
        destinationRoot: f.path.join(f.root, "destination"),
        codexVersion: version,
      });
      expect(yield* f.fs.readFileString(imported.rolloutPath)).toContain(newerVersion);
      const nativeVersions: string[] = [];
      for (const file of imported.rolloutPaths) {
        const text = yield* f.fs.readFileString(file);
        nativeVersions.push(
          parseCodexNativeRollout(f.path.basename(file), text).metadata.cli_version,
        );
      }
      expect(nativeVersions.sort()).toEqual([version, "0.160.0", newerVersion].sort());
    }),
  );

  it.effect(
    "blocks a missing child before publishing and a missing prefix before installation",
    () =>
      Effect.gen(function* () {
        const f = yield* graphFixture;
        const exported = yield* exportCodexConversation(f.input);
        yield* f.fs.remove(f.child);
        expect(yield* Effect.flip(exportCodexConversation(f.input))).toMatchObject({
          _tag: "CodexConversationTransferError",
        });
        const prefix = f.path.join(
          exported.directory,
          "native-rollouts",
          f.path.basename(f.rolloutPath),
        );
        yield* f.fs.remove(prefix);
        const destinationRoot = f.path.join(f.root, "destination");
        expect(
          yield* Effect.flip(
            importCodexConversation({
              manifest: exported.manifest,
              rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
              destinationRoot,
              codexVersion: version,
            }),
          ),
        ).toMatchObject({ _tag: "CodexConversationTransferError" });
        expect(yield* f.fs.exists(destinationRoot)).toBe(false);
      }),
  );

  it.effect("refuses a graph manifest with omitted history or conflicting root metadata", () =>
    Effect.gen(function* () {
      const f = yield* graphFixture;
      const exported = yield* exportCodexConversation(f.input);
      for (const manifest of [
        {
          ...exported.manifest,
          rollouts: exported.manifest.rollouts!.filter(
            (r) => !r.rolloutName.includes(childNativeId),
          ),
        },
        {
          ...exported.manifest,
          heads: { ...exported.manifest.heads, [nativeId]: f.path.basename(f.rolloutPath) },
        },
        { ...exported.manifest, codexVersion: newerVersion },
      ])
        expect(
          yield* Effect.flip(
            importCodexConversation({
              manifest,
              rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
              destinationRoot: f.path.join(f.root, "destination"),
              codexVersion: version,
            }),
          ),
        ).toMatchObject({ _tag: "CodexConversationTransferError" });
    }),
  );

  it.effect("preserves the pinned paginated image marker and unrelated native metadata", () =>
    Effect.gen(function* () {
      const f = yield* referencedFixture;
      const marker = `<image name=[Image #1] path="${f.image}">`;
      const original = {
        timestamp: "2026-10-01T12:00:01Z",
        type: "response_item",
        outer: 7,
        payload: {
          type: "message",
          id: "same-message-id",
          role: "user",
          content: [
            { type: "input_text", text: marker, extra: 9 },
            { type: "input_image", image_url: "data:image/png;base64,retained" },
            { type: "input_text", text: `An ordinary mention of ${f.audio}` },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: "same-turn-id" },
        },
      };
      yield* f.fs.writeFileString(f.rolloutPath, f.contents + encodeJson(original) + "\n");
      const exported = yield* exportCodexConversation(f.input);
      expect(exported.manifest.files).toHaveLength(1);
      const imported = yield* importCodexConversation({
        manifest: exported.manifest,
        rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
        destinationRoot: f.path.join(f.root, "destination"),
        codexVersion: version,
      });
      const target = f.path.join(
        imported.homePath,
        "native-files",
        exported.manifest.files![0]!.name,
      );
      const text = yield* f.fs.readFileString(imported.rolloutPath);
      const actual = yield* decodeJson(text.trim().split("\n").at(-1));
      expect(actual).toEqual({
        ...original,
        payload: {
          ...original.payload,
          content: [
            { ...original.payload.content[0], text: `<image name=[Image #1] path="${target}">` },
            original.payload.content[1],
            original.payload.content[2],
          ],
        },
      });
      expect(yield* f.fs.exists(target)).toBe(true);
    }),
  );

  it.effect.skipIf(!symlinksSupported)("refuses native source and artifact file symlinks", () =>
    Effect.gen(function* () {
      const f = yield* referencedFixture;
      const outside = f.path.join(yield* f.fs.realPath(f.root), "outside.png");
      yield* f.fs.copyFile(f.image, outside);
      yield* f.fs.remove(f.image);
      yield* f.fs.symlink(outside, f.image);
      expect(yield* Effect.flip(exportCodexConversation(f.input))).toMatchObject({
        _tag: "CodexConversationTransferError",
      });
      yield* f.fs.remove(f.image);
      yield* f.fs.copyFile(outside, f.image);
      const exported = yield* exportCodexConversation(f.input);
      const object = f.path.join(exported.directory, "files", exported.manifest.files![0]!.name);
      yield* f.fs.remove(object);
      yield* f.fs.symlink(outside, object);
      const destinationRoot = f.path.join(f.root, "destination");
      expect(
        yield* Effect.flip(
          importCodexConversation({
            manifest: exported.manifest,
            rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
            destinationRoot,
            codexVersion: version,
          }),
        ),
      ).toMatchObject({ _tag: "CodexConversationTransferError" });
      expect(yield* f.fs.readDirectory(destinationRoot)).toEqual([]);
    }),
  );
  it.effect("retains and relocates only explicit native files, including a second move", () =>
    Effect.gen(function* () {
      const f = yield* referencedFixture;
      const exported = yield* exportCodexConversation(f.input);
      expect(exported.manifest.format).toBe("codex-rollout-v2");
      expect(exported.manifest.files).toHaveLength(2);
      yield* f.fs.remove(f.filesRoot, { recursive: true });
      const imported = yield* importCodexConversation({
        manifest: exported.manifest,
        rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
        destinationRoot: f.path.join(f.root, "destination"),
        codexVersion: version,
      });
      const lines = (yield* f.fs.readFileString(imported.rolloutPath)).trim().split("\n");
      const record = yield* decodeJson(lines.at(-1));
      const expected = {
        ...f.event,
        payload: {
          ...f.event.payload,
          local_images: [
            f.path.join(imported.homePath, "native-files", exported.manifest.files![0]!.name),
          ],
          local_audio: [
            f.path.join(imported.homePath, "native-files", exported.manifest.files![1]!.name),
          ],
        },
      };
      expect(record).toEqual(expected);
      expect(Array.from(yield* f.fs.readFile(expected.payload.local_images[0]!))).toEqual([
        137, 80, 78, 71, 0, 1,
      ]);
      expect(Array.from(yield* f.fs.readFile(expected.payload.local_audio[0]!))).toEqual([
        82, 73, 70, 70, 1, 2,
      ]);
      const returned = yield* exportCodexConversation({
        codexHome: imported.homePath,
        rolloutPath: imported.rolloutPath,
        threadId: nativeId,
        artifactRoot: f.path.join(f.root, "return-artifacts"),
      });
      expect(returned.manifest.files?.map((file) => file.sha256)).toEqual(
        exported.manifest.files?.map((file) => file.sha256),
      );
      const final = yield* importCodexConversation({
        manifest: returned.manifest,
        rolloutPath: f.path.join(returned.directory, "rollout.jsonl"),
        destinationRoot: f.path.join(f.root, "return-home"),
        codexVersion: version,
      });
      expect(yield* f.fs.readDirectory(f.path.join(final.homePath, "native-files"))).toHaveLength(
        2,
      );
    }),
  );

  it.effect("blocks a referenced file outside this thread's permitted roots", () =>
    Effect.gen(function* () {
      const f = yield* referencedFixture;
      const error = yield* Effect.flip(
        exportCodexConversation({ ...f.input, referencedFileRoots: [f.home] }),
      );
      expect(error.message).toContain("permitted storage");
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
      expect(yield* f.fs.exists(f.image)).toBe(true);
    }),
  );

  for (const invalid of ["missing", "corrupt", "unlisted", "legacy"] as const) {
    it.effect(`refuses ${invalid} native file artifacts and removes the partial home`, () =>
      Effect.gen(function* () {
        const f = yield* referencedFixture;
        const exported = yield* exportCodexConversation(f.input);
        const files = exported.manifest.files!;
        const object = f.path.join(exported.directory, "files", files[0]!.name);
        if (invalid === "missing") yield* f.fs.remove(object);
        if (invalid === "corrupt")
          yield* f.fs.writeFile(object, new Uint8Array([0, 0, 0, 0, 0, 0]));
        const manifest =
          invalid === "legacy"
            ? { ...exported.manifest, format: "codex-rollout-v1", files: [] }
            : invalid === "unlisted"
              ? { ...exported.manifest, files: files.slice(1) }
              : exported.manifest;
        const destinationRoot = f.path.join(f.root, "destination");
        const error = yield* Effect.flip(
          importCodexConversation({
            manifest,
            rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
            destinationRoot,
            codexVersion: version,
          }),
        );
        expect(error).toMatchObject({ _tag: "CodexConversationTransferError" });
        expect(yield* f.fs.readDirectory(destinationRoot)).toEqual([]);
      }),
    );
  }

  it.effect("rejects malformed local file fields and opaque remote file references", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const payload of [
        { type: "user_message", local_images: "/wrong/type.png" },
        { type: "user_message", file_ids: ["remote-account-file"] },
      ]) {
        yield* f.fs.writeFileString(
          f.rolloutPath,
          f.contents + encodeJson({ type: "event_msg", payload }) + "\n",
        );
        expect(yield* Effect.flip(exportCodexConversation(f.input))).toMatchObject({
          _tag: "CodexConversationTransferError",
        });
      }
    }),
  );

  it.effect("refuses the unverified legacy native format", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(f.rolloutPath, f.contents.replace("paginated", "legacy"));
      const error = yield* Effect.flip(exportCodexConversation(f.input));
      expect(error.message).toContain("has not been verified");
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
    }),
  );

  it.effect("retains the source version when materializing history for a different runtime", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const contents = f.contents.replace(version, newerVersion);
      yield* f.fs.writeFileString(f.rolloutPath, contents);
      const exported = yield* exportCodexConversation(f.input);
      expect(exported.manifest.codexVersion).toBe(newerVersion);
      const imported = yield* importCodexConversation({
        manifest: exported.manifest,
        rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
        destinationRoot: f.path.join(f.root, "destination"),
        codexVersion: version,
      });
      expect(yield* f.fs.readFileString(imported.rolloutPath)).toBe(contents);
      expect(yield* f.fs.readFileString(f.rolloutPath)).toBe(contents);
    }),
  );

  it.effect("rejects a manifest source version that disagrees with its history", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const exported = yield* exportCodexConversation(f.input);
      const destinationRoot = f.path.join(f.root, "destination");
      const error = yield* Effect.flip(
        importCodexConversation({
          manifest: { ...exported.manifest, codexVersion: newerVersion },
          rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
          destinationRoot,
          codexVersion: newerVersion,
        }),
      );
      expect(error.message).toContain("manifest identity mismatch");
      expect(yield* f.fs.readDirectory(destinationRoot)).toEqual([]);
      expect(yield* f.fs.readFileString(f.rolloutPath)).toBe(f.contents);
    }),
  );
  it.effect(
    "retains native history in a fresh home without credentials or other conversations",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const exported = yield* exportCodexConversation(f.input);
        expect((yield* f.fs.readDirectory(exported.directory)).sort()).toEqual([
          "manifest.json",
          "rollout.jsonl",
        ]);
        const imported = yield* importCodexConversation({
          manifest: exported.manifest,
          rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
          destinationRoot: f.path.join(f.root, "destination"),
          codexVersion: version,
        });
        expect(yield* f.fs.readFileString(imported.rolloutPath)).toEqual(f.contents);
        expect(yield* f.fs.readDirectory(imported.homePath)).toEqual(["sessions"]);
        expect(imported.resumeCursor).toEqual({
          threadId: nativeId,
          resumePolicy: "require-existing",
        });
        expect(yield* f.fs.readFileString(f.path.join(f.home, "auth.json"))).toEqual(
          "test-login-must-not-transfer",
        );
      }),
  );

  for (const dependency of [
    { parent_thread_id: "01900000-0000-7000-8000-000000000002" },
    { history_base: { rollout_file: "/another/conversation.jsonl", end_ordinal_exclusive: 10 } },
  ]) {
    it.effect(`blocks native dependencies before publishing: ${Object.keys(dependency)[0]}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const lines = f.contents.split("\n");
        lines[0] = encodeJson({
          type: "session_meta",
          payload: {
            id: nativeId,
            cli_version: version,
            history_mode: "paginated",
            ...dependency,
          },
        });
        yield* f.fs.writeFileString(f.rolloutPath, lines.join("\n"));
        expect(yield* Effect.flip(exportCodexConversation(f.input))).toMatchObject({
          _tag: "CodexConversationTransferError",
          message: expect.stringContaining("other native sessions"),
        });
        expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
      }),
    );
  }

  for (const record of [
    {
      type: "event_msg",
      payload: {
        type: "collab_agent_spawn_end",
        new_thread_id: "01900000-0000-7000-8000-000000000002",
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call", name: "spawn_agent", arguments: "{}" },
    },
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "functions.spawn_agent", input: "{}" },
    },
    {
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "collab_agent_tool_call" } },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CollabAgentToolCall",
          tool: "wait",
          status: "completed",
          sender_thread_id: nativeId,
          receiver_thread_ids: [],
          receiver_agents: [],
          agents_states: {},
        },
      },
    },
  ]) {
    it.effect(`blocks a child dependency in native records: ${record.payload.type}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(f.rolloutPath, f.contents + encodeJson(record) + "\n");
        expect(yield* Effect.flip(exportCodexConversation(f.input))).toMatchObject({
          _tag: "CodexConversationTransferError",
          message: expect.stringContaining("other native sessions"),
        });
        expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
      }),
    );
  }

  it.effect(
    "refuses inherited native history on import even with matching bytes and checksum",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const exported = yield* exportCodexConversation(f.input);
        const lines = f.contents.split("\n");
        lines[0] = encodeJson({
          type: "session_meta",
          payload: {
            id: nativeId,
            cli_version: version,
            history_mode: "paginated",
            history_base: { rollout_file: "missing.jsonl" },
          },
        });
        const contents = lines.join("\n");
        const rolloutPath = f.path.join(exported.directory, "rollout.jsonl");
        yield* f.fs.writeFileString(rolloutPath, contents);
        const destinationRoot = f.path.join(f.root, "destination");
        expect(
          yield* Effect.flip(
            importCodexConversation({
              manifest: {
                ...exported.manifest,
                sha256: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
              },
              rolloutPath,
              destinationRoot,
              codexVersion: version,
            }),
          ),
        ).toMatchObject({
          _tag: "CodexConversationTransferError",
          message: expect.stringContaining("other native sessions"),
        });
        expect(yield* f.fs.readDirectory(destinationRoot)).toEqual([]);
      }),
  );

  for (const suffix of [
    '{"type":"response_item","payload":',
    '{"type":"response_item","payload":null}',
    "{broken-json}\n",
  ]) {
    it.effect(
      `refuses a corrupt source even when it could receive a matching checksum: ${suffix}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.fs.writeFileString(f.rolloutPath, f.contents + suffix);
          const error = yield* exportCodexConversation(f.input).pipe(Effect.flip);
          expect(error._tag).toBe("CodexConversationTransferError");
          expect(error.message).toContain("native record");
          expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
          expect(yield* f.fs.readFileString(f.rolloutPath)).toEqual(f.contents + suffix);
        }),
    );
  }

  it.effect("preserves multibyte native text across streaming boundaries", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const contents =
        f.contents + encodeJson({ type: "response_item", payload: { text: "Grüße 🧑‍💻" } }) + "\n";
      yield* f.fs.writeFileString(f.rolloutPath, contents);
      const fragmentedFs = {
        ...f.fs,
        stream: (file: string) =>
          f.fs
            .stream(file)
            .pipe(
              Stream.flatMap((chunk) =>
                Stream.fromIterable(Array.from(chunk, (byte) => Uint8Array.of(byte))),
              ),
            ),
      };
      const exported = yield* exportCodexConversation(f.input).pipe(
        Effect.provideService(FileSystem.FileSystem, fragmentedFs),
      );
      const imported = yield* importCodexConversation({
        manifest: exported.manifest,
        rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
        destinationRoot: f.path.join(f.root, "destination"),
        codexVersion: version,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fragmentedFs));
      expect(yield* f.fs.readFileString(imported.rolloutPath)).toEqual(contents);
    }),
  );

  it.effect("refuses invalid UTF-8 rather than replacing bytes in native history", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = new TextEncoder().encode(
        f.contents + '{"type":"response_item","payload":{"text":"',
      );
      const after = new TextEncoder().encode('"}}\n');
      const bytes = new Uint8Array(before.length + 1 + after.length);
      bytes.set(before);
      bytes[before.length] = 255;
      bytes.set(after, before.length + 1);
      yield* f.fs.writeFile(f.rolloutPath, bytes);
      const error = yield* exportCodexConversation(f.input).pipe(Effect.flip);
      expect(error.message).toContain("UTF-8");
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
    }),
  );

  it.effect("refuses another thread's rollout before publishing an artifact", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const error = yield* exportCodexConversation({
        ...f.input,
        threadId: "01900000-0000-7000-8000-000000000002",
      }).pipe(Effect.flip);
      expect(error.message).toContain("different conversation");
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
    }),
  );

  it.effect.skipIf(!symlinksSupported)("refuses a session symlink into unrelated host files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const external = f.path.join(f.root, "outside.jsonl");
      yield* f.fs.rename(f.rolloutPath, external);
      yield* f.fs.symlink(external, f.rolloutPath);
      const error = yield* exportCodexConversation(f.input).pipe(Effect.flip);
      expect(error.message).toContain("provider home's session storage");
    }),
  );

  it.effect("rejects a changed source and removes the incomplete export", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const changedFs = {
        ...f.fs,
        copyFile: (source: string, destination: string) =>
          f.fs
            .copyFile(source, destination)
            .pipe(
              Effect.andThen(f.fs.writeFileString(source, `${f.contents}{"type":"new-event"}\n`)),
            ),
      };
      const error = yield* exportCodexConversation(f.input).pipe(
        Effect.provideService(FileSystem.FileSystem, changedFs),
        Effect.flip,
      );
      expect(error.message).toContain("changed during export");
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
      expect(yield* f.fs.readFileString(f.rolloutPath)).toContain("new-event");
    }),
  );

  it.effect("rejects corrupted data and removes the partial destination", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const exported = yield* exportCodexConversation(f.input);
      const artifactPath = f.path.join(exported.directory, "rollout.jsonl");
      yield* f.fs.writeFileString(artifactPath, `${f.contents}changed`);
      const destinationRoot = f.path.join(f.root, "destination");
      const error = yield* importCodexConversation({
        manifest: exported.manifest,
        rolloutPath: artifactPath,
        destinationRoot,
        codexVersion: version,
      }).pipe(Effect.flip);
      expect(error.message).toContain("integrity check");
      expect(yield* f.fs.readDirectory(destinationRoot)).toEqual([]);
      expect(yield* f.fs.readFileString(f.rolloutPath)).toEqual(f.contents);
    }),
  );

  it.effect("rejects corrupt native records even when the artifact checksum matches", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(f.rolloutPath, f.contents.replace(version, newerVersion));
      const exported = yield* exportCodexConversation(f.input);
      const corrupted =
        f.contents.replace(version, newerVersion) + '{"type":"response_item","payload":';
      const rolloutPath = f.path.join(exported.directory, "rollout.jsonl");
      yield* f.fs.writeFileString(rolloutPath, corrupted);
      const destinationRoot = f.path.join(f.root, "destination");
      const error = yield* importCodexConversation({
        manifest: {
          ...exported.manifest,
          sha256: NodeCrypto.createHash("sha256").update(corrupted).digest("hex"),
        },
        rolloutPath,
        destinationRoot,
        codexVersion: version,
      }).pipe(Effect.flip);
      expect(error.message).toContain("native record");
      expect(yield* f.fs.readDirectory(destinationRoot)).toEqual([]);
      expect(yield* f.fs.readFileString(f.rolloutPath)).toEqual(
        f.contents.replace(version, newerVersion),
      );
    }),
  );

  for (const operation of ["export", "import"] as const) {
    it.effect(`cleans only incomplete ${operation} data when interrupted`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const exported = yield* exportCodexConversation(f.input);
        const destinationRoot = f.path.join(f.root, "destination");
        const copied = yield* Deferred.make<void>();
        const interruptedFs = {
          ...f.fs,
          copyFile: (source: string, destination: string) =>
            f.fs
              .copyFile(source, destination)
              .pipe(
                Effect.andThen(Deferred.succeed(copied, undefined)),
                Effect.andThen(Effect.never),
              ),
        };
        const work =
          operation === "export"
            ? exportCodexConversation(f.input).pipe(Effect.asVoid)
            : importCodexConversation({
                manifest: exported.manifest,
                rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
                destinationRoot,
                codexVersion: version,
              }).pipe(Effect.asVoid);
        const fiber = yield* work.pipe(
          Effect.provideService(FileSystem.FileSystem, interruptedFs),
          Effect.forkChild,
        );
        yield* Deferred.await(copied);
        yield* Fiber.interrupt(fiber);
        expect(yield* f.fs.readFileString(f.rolloutPath)).toEqual(f.contents);
        expect(
          yield* f.fs.readFileString(f.path.join(exported.directory, "rollout.jsonl")),
        ).toEqual(f.contents);
        if (operation === "import") expect(yield* f.fs.readDirectory(destinationRoot)).toEqual([]);
        else
          expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([
            f.path.basename(exported.directory),
          ]);
      }),
    );
  }

  describe("import compatibility", () => {
    for (const mutation of [
      { manifest: { codexVersion: "" } },
      { manifest: { codexVersion: "v".repeat(129) } },
      { manifest: { rolloutName: "../../auth.json" } },
      { manifest: { format: "unknown-format" } },
      { manifest: { threadId: "01900000-0000-7000-8000-000000000002" } },
    ]) {
      it.effect(`rejects incompatible input ${encodeJson(mutation)}`, () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const exported = yield* exportCodexConversation(f.input);
          const destinationRoot = f.path.join(f.root, "destination");
          yield* importCodexConversation({
            manifest: { ...exported.manifest, ...mutation.manifest },
            rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
            destinationRoot,
            codexVersion: version,
          }).pipe(Effect.flip);
          expect(yield* f.fs.exists(destinationRoot)).toBe(false);
        }),
      );
    }
  });
});
