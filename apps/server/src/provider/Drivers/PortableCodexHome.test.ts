import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { exportCodexConversation } from "./CodexConversationTransfer.ts";
import {
  installPortableCodexHome,
  exportUnstartedPortableCodexConversation,
  resolvePortableCodexHome,
  preparePortableCodexAuthentication,
} from "./PortableCodexHome.ts";

const nativeId = "01900000-0000-7000-8000-000000000001";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "portable-codex-home-" }),
  );
  const home = path.join(root, "source");
  const date = path.join(home, "sessions", "2026", "10", "01");
  yield* fs.makeDirectory(date, { recursive: true });
  const name = `rollout-2026-10-01T12-00-00-${nativeId}.jsonl`;
  yield* fs.writeFileString(
    path.join(date, name),
    `{"type":"session_meta","payload":{"id":"${nativeId}","cli_version":"0.159.3","history_mode":"paginated"}}\n` +
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"remember a private fact"}]}}\n',
  );
  yield* fs.writeFileString(path.join(home, "auth.json"), "never transfer login data");
  const exported = yield* exportCodexConversation({
    codexHome: home,
    threadId: nativeId,
    rolloutPath: path.join(date, name),
    artifactRoot: path.join(root, "artifacts"),
  });
  const input = {
    stateDir: path.join(root, "state"),
    threadId: "launchpad-thread",
    operationId: "move-1",
    providerInstanceId: "codex",
    transferSha256: "a".repeat(64),
    manifest: exported.manifest,
    rolloutPath: path.join(exported.directory, "rollout.jsonl"),
    codexVersion: "0.159.3",
  };
  return { root, fs, path, home, input, name };
});
it.layer(NodeServices.layer)("portable Codex homes", (it) => {
  it.effect(
    "an unstarted imported conversation can be saved again after the source is gone without transferring authentication",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture,
          installed = yield* installPortableCodexHome(f.input);
        yield* f.fs.writeFileString(
          f.path.join(installed.homePath, "auth.json"),
          "destination-secret-never-export",
        );
        yield* f.fs.remove(f.home, { recursive: true });
        const archive = yield* exportUnstartedPortableCodexConversation({
          ...f.input,
          nativeThreadId: nativeId,
          portableStateId: installed.resumeCursor.portableStateId,
          artifactRoot: f.path.join(f.root, "second-save"),
        });
        expect(archive.manifest.threadId).toBe(nativeId);
        expect(yield* f.fs.exists(f.path.join(archive.directory, "auth.json"))).toBe(false);
        expect(
          yield* f.fs.readFileString(f.path.join(archive.directory, "rollout.jsonl")),
        ).toContain("remember a private fact");
      }),
  );
  it.effect(
    "an imported conversation with appended provider work requires its own settled checkpoint",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture,
          installed = yield* installPortableCodexHome(f.input);
        const file = f.path.join(installed.homePath, "sessions", "2026", "10", "01", f.name);
        yield* f.fs.writeFileString(file, (yield* f.fs.readFileString(file)) + "{}\n");
        expect(
          (yield* Effect.flip(
            exportUnstartedPortableCodexConversation({
              ...f.input,
              nativeThreadId: nativeId,
              portableStateId: installed.resumeCursor.portableStateId,
              artifactRoot: f.path.join(f.root, "second-save"),
            }),
          )).message,
        ).toContain("settled destination checkpoint");
      }),
  );
  it.effect("native file references survive atomic home publication and block corrupt reopen", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const files = f.path.join(f.home, "native-files");
      yield* f.fs.makeDirectory(files);
      const image = f.path.join(files, "source.png");
      const bytes = new Uint8Array([137, 80, 78, 71]);
      yield* f.fs.writeFile(image, bytes);
      const sourceRollout = f.path.join(f.home, "sessions", "2026", "10", "01", f.name);
      yield* f.fs.writeFileString(
        sourceRollout,
        (yield* f.fs.readFileString(sourceRollout)) +
          (yield* encodeJson({
            timestamp: "2026-10-01T12:00:01Z",
            type: "event_msg",
            payload: { type: "user_message", local_images: [image] },
          })) +
          "\n",
      );
      const exported = yield* exportCodexConversation({
        codexHome: f.home,
        threadId: nativeId,
        rolloutPath: sourceRollout,
        artifactRoot: f.path.join(f.root, "files-artifact"),
      });
      const input = {
        ...f.input,
        manifest: exported.manifest,
        rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
      };
      const installed = yield* installPortableCodexHome(input);
      const file = f.path.join(
        installed.homePath,
        "native-files",
        exported.manifest.files![0]!.name,
      );
      const text = yield* f.fs.readFileString(
        f.path.join(installed.homePath, "sessions", "2026", "10", "01", f.name),
      );
      expect(text).toContain(file);
      expect(Array.from(yield* f.fs.readFile(file))).toEqual(Array.from(bytes));
      expect(yield* installPortableCodexHome(input)).toEqual(installed);
      const resolve = {
        stateDir: f.input.stateDir,
        threadId: f.input.threadId,
        providerInstanceId: f.input.providerInstanceId,
        nativeThreadId: nativeId,
        portableStateId: installed.resumeCursor.portableStateId,
      };
      expect(yield* resolvePortableCodexHome(resolve)).toMatchObject({
        homePath: installed.homePath,
      });
      yield* f.fs.writeFile(file, new Uint8Array([0, 0, 0, 0]));
      expect(yield* Effect.flip(resolvePortableCodexHome(resolve))).toMatchObject({
        _tag: "CodexConversationTransferError",
        message: expect.stringContaining("file is missing or changed"),
      });
    }),
  );
  it.effect("installs one private native home and resolves it after the source is gone", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const installed = yield* installPortableCodexHome(f.input);
      expect(yield* f.fs.exists(f.path.join(installed.homePath, "auth.json"))).toBe(false);
      expect(yield* installPortableCodexHome(f.input)).toEqual(installed);
      yield* f.fs.remove(f.home, { recursive: true });
      const resolved = yield* resolvePortableCodexHome({
        ...f.input,
        nativeThreadId: nativeId,
        portableStateId: installed.resumeCursor.portableStateId,
      });
      expect(resolved.homePath).toBe(installed.homePath);
      expect(installed.resumeCursor.resumePolicy).toBe("require-existing");
      // The native runtime appends here after activation; the import checksum is
      // intentionally not treated as an immutable checksum of a live conversation.
      yield* f.fs.writeFileString(
        f.path.join(installed.homePath, "sessions", "2026", "10", "01", f.name),
        '{"type":"event_msg","payload":{"type":"turn_complete"}}\n',
        { flag: "a" },
      );
      expect(
        (yield* resolvePortableCodexHome({
          ...f.input,
          nativeThreadId: nativeId,
          portableStateId: installed.resumeCursor.portableStateId,
        })).homePath,
      ).toBe(installed.homePath);
    }),
  );
  it.effect("blocks a changed installed prefix while permitting later native appends", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const installed = yield* installPortableCodexHome(f.input);
      const rollout = f.path.join(installed.homePath, "sessions", "2026", "10", "01", f.name);
      const text = yield* f.fs.readFileString(rollout);
      const request = {
        ...f.input,
        nativeThreadId: nativeId,
        portableStateId: installed.resumeCursor.portableStateId,
      };
      yield* f.fs.writeFileString(rollout, text.replace("private fact", "changed fact"));
      expect(yield* Effect.flip(resolvePortableCodexHome(request))).toMatchObject({
        _tag: "CodexConversationTransferError",
        message: expect.stringContaining("history is missing or changed"),
      });
      yield* f.fs.writeFileString(rollout, text);
      yield* f.fs.writeFileString(
        rollout,
        '{"type":"event_msg","payload":{"type":"turn_complete"}}\n',
        { flag: "a" },
      );
      expect((yield* resolvePortableCodexHome(request)).homePath).toBe(installed.homePath);
      yield* f.fs.writeFileString(rollout, text.slice(0, -1));
      yield* Effect.flip(resolvePortableCodexHome(request));
    }),
  );
  it.effect(
    "verifies every imported native dependency and refuses a missing integrity receipt",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const childId = "01900000-0000-7000-8000-000000000002";
        const meta = {
          id: nativeId,
          session_id: nativeId,
          cli_version: "0.159.3",
          history_mode: "paginated",
        };
        const row = Effect.fnUntraced(function* (ordinal: number, type: string, payload: unknown) {
          return (
            (yield* encodeJson({ timestamp: "2026-10-01T12:00:00Z", ordinal, type, payload })) +
            "\n"
          );
        });
        const directory = f.path.join(f.home, "sessions", "2026", "10", "01");
        const root = f.path.join(directory, f.name);
        const prefix =
          (yield* row(0, "session_meta", meta)) +
          (yield* row(1, "response_item", {
            type: "function_call",
            name: "spawn_agent",
            call_id: "child-create",
            arguments: "opaque",
          })) +
          (yield* row(2, "response_item", {
            type: "function_call_output",
            call_id: "child-create",
            output: '{"task_name":"/root/child"}',
          }));
        yield* f.fs.writeFileString(root, prefix);
        const childName = f.name.replace(nativeId, childId);
        yield* f.fs.writeFileString(
          f.path.join(directory, childName),
          (yield* row(0, "session_meta", {
            ...meta,
            id: childId,
            parent_thread_id: nativeId,
            forked_from_id: nativeId,
            agent_path: "/root/child",
            subagent_history_start_ordinal: 1,
          })) +
            (yield* row(1, "event_msg", {
              type: "user_message",
              message: "child fact",
              local_images: [],
              file_ids: [],
            })),
        );
        const revertedId = "01900000-0000-7000-8000-000000000003";
        const headName = f.name.replace(`${nativeId}.jsonl`, `${nativeId}_${revertedId}.jsonl`);
        const head = f.path.join(directory, headName);
        yield* f.fs.writeFileString(
          head,
          yield* row(3, "session_meta", {
            ...meta,
            history_base: {
              thread_id: nativeId,
              end_ordinal_exclusive: 3,
              end_byte_offset: Buffer.byteLength(prefix),
            },
          }),
        );
        const exported = yield* exportCodexConversation({
          codexHome: f.home,
          threadId: nativeId,
          rolloutPath: head,
          artifactRoot: f.path.join(f.root, "graph-artifact"),
        });
        const input = {
          ...f.input,
          manifest: exported.manifest,
          rolloutPath: f.path.join(exported.directory, "rollout.jsonl"),
        };
        const installed = yield* installPortableCodexHome(input);
        const request = {
          ...f.input,
          nativeThreadId: nativeId,
          portableStateId: installed.resumeCursor.portableStateId,
        };
        expect(exported.manifest.rollouts).toHaveLength(3);
        for (const name of [f.name, childName, headName]) {
          const file = f.path.join(installed.homePath, "sessions", "2026", "10", "01", name);
          const bytes = yield* f.fs.readFile(file);
          const changed = Uint8Array.from(bytes);
          changed[0] = 0;
          yield* f.fs.writeFile(file, changed);
          expect((yield* Effect.flip(resolvePortableCodexHome(request))).message).toContain(
            "history is missing or changed",
          );
          yield* Effect.flip(installPortableCodexHome(input));
          yield* f.fs.writeFile(file, bytes);
          yield* f.fs.remove(file);
          yield* Effect.flip(resolvePortableCodexHome(request));
          yield* f.fs.writeFile(file, bytes);
        }
        const child = f.path.join(installed.homePath, "sessions", "2026", "10", "01", childName);
        yield* f.fs.writeFileString(child, yield* row(2, "event_msg", { type: "turn_complete" }), {
          flag: "a",
        });
        expect((yield* resolvePortableCodexHome(request)).homePath).toBe(installed.homePath);
        const receipt = f.path.join(installed.homePath, "launchpad-native-integrity.json");
        const saved = yield* f.fs.readFileString(receipt);
        yield* f.fs.writeFileString(
          receipt,
          saved.replace(installed.resumeCursor.portableStateId, "b".repeat(64)),
        );
        yield* Effect.flip(resolvePortableCodexHome(request));
        yield* f.fs.remove(receipt);
        yield* Effect.flip(installPortableCodexHome(input));
        yield* Effect.flip(resolvePortableCodexHome(request));
      }),
  );
  it.effect("rejects another thread, provider instance, or native conversation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const installed = yield* installPortableCodexHome(f.input);
      const request = {
        ...f.input,
        nativeThreadId: nativeId,
        portableStateId: installed.resumeCursor.portableStateId,
      };
      yield* Effect.flip(resolvePortableCodexHome({ ...request, threadId: "other-thread" }));
      expect(
        (yield* Effect.flip(
          resolvePortableCodexHome({ ...request, providerInstanceId: "other-instance" }),
        )).message,
      ).toContain("does not belong");
      expect(
        (yield* Effect.flip(
          resolvePortableCodexHome({
            ...request,
            nativeThreadId: "01900000-0000-7000-8000-000000000002",
          }),
        )).message,
      ).toContain("does not belong");
      yield* Effect.flip(resolvePortableCodexHome({ ...request, portableStateId: "../source" }));
    }),
  );
  it.effect("installs and reopens native history on a different destination Codex version", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const installed = yield* installPortableCodexHome({ ...f.input, codexVersion: "0.160.0" });
      expect(
        yield* installPortableCodexHome({ ...f.input, codexVersion: "0.163.0-alpha.10.2" }),
      ).toEqual(installed);
      expect(
        yield* resolvePortableCodexHome({
          ...f.input,
          nativeThreadId: nativeId,
          portableStateId: installed.resumeCursor.portableStateId,
        }),
      ).toEqual({ homePath: installed.homePath, codexVersion: "0.159.3" });
    }),
  );
  it.effect("does not replace missing native history with the configured provider home", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const installed = yield* installPortableCodexHome(f.input);
      yield* f.fs.remove(f.path.join(installed.homePath, "sessions"), { recursive: true });
      yield* Effect.flip(
        resolvePortableCodexHome({
          ...f.input,
          nativeThreadId: nativeId,
          portableStateId: installed.resumeCursor.portableStateId,
        }),
      );
    }),
  );
  it.effect("rejects changed ownership records and linked native homes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const installed = yield* installPortableCodexHome(f.input);
      const request = {
        ...f.input,
        nativeThreadId: nativeId,
        portableStateId: installed.resumeCursor.portableStateId,
      };
      const receipt = f.path.join(installed.homePath, "launchpad-state.json");
      const text = yield* f.fs.readFileString(receipt);
      yield* f.fs.writeFileString(receipt, text.replace("move-1", "move-2"));
      yield* Effect.flip(resolvePortableCodexHome(request));
      yield* f.fs.writeFileString(receipt, text);
      const moved = `${installed.homePath}-moved`;
      yield* f.fs.rename(installed.homePath, moved);
      yield* f.fs.symlink(moved, installed.homePath);
      expect((yield* Effect.flip(resolvePortableCodexHome(request))).message).toContain(
        "linked provider home",
      );
    }),
  );
  it.effect(
    "uses destination credentials, retains refreshed tokens, and follows a changed sign-in",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const installed = yield* installPortableCodexHome(f.input);
        const account = f.path.join(f.root, "destination-account");
        yield* f.fs.makeDirectory(account);
        const prepare = preparePortableCodexAuthentication({
          homePath: installed.homePath,
          configuredHomePath: account,
        });
        expect((yield* Effect.flip(prepare)).message).toContain("Sign in");
        yield* f.fs.writeFileString(f.path.join(account, "auth.json"), "destination sign-in");
        yield* prepare;
        const privateAuth = f.path.join(installed.homePath, "auth.json");
        expect(yield* f.fs.readFileString(privateAuth)).toBe("destination sign-in");
        yield* f.fs.writeFileString(privateAuth, "refreshed locally");
        yield* prepare;
        expect(yield* f.fs.readFileString(privateAuth)).toBe("refreshed locally");
        expect(yield* f.fs.readFileString(f.path.join(account, "auth.json"))).toBe(
          "destination sign-in",
        );
        yield* f.fs.writeFileString(
          f.path.join(account, "auth.json"),
          "different destination account",
        );
        yield* prepare;
        expect(yield* f.fs.readFileString(privateAuth)).toBe("different destination account");
        yield* f.fs.remove(f.path.join(account, "auth.json"));
        expect((yield* Effect.flip(prepare)).message).toContain("Sign in");
      }),
  );
  it.effect("never writes authentication through a link to another home", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const installed = yield* installPortableCodexHome(f.input);
      yield* f.fs.symlink(
        f.path.join(f.home, "auth.json"),
        f.path.join(installed.homePath, "auth.json"),
      );
      expect(
        (yield* Effect.flip(
          preparePortableCodexAuthentication({
            homePath: installed.homePath,
            configuredHomePath: f.home,
          }),
        )).message,
      ).toContain("regular private files");
      expect(yield* f.fs.readFileString(f.path.join(f.home, "auth.json"))).toBe(
        "never transfer login data",
      );
    }),
  );
});
