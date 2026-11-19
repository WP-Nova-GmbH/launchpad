import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "../../processRunner.ts";
import { VmCoordinatorProcess } from "../../vmWorkloadCommand.ts";
import { stageWorkflowCheckpoint } from "../../vcs/WorkflowCheckpointReader.ts";
import {
  exportCodexConversation,
  CodexConversationTransferError,
} from "./CodexConversationTransfer.ts";

// The isolated interpreter lists only conversation data, never config or auth.
// Native graph validation and attachment provenance remain in the normal exporter.
const listConversationFiles = String.raw`
import json, os, re, stat, sys
thread = sys.argv[1]
paths = []
rollout_bytes = 0
file_bytes = 0
rollouts = 0
files = 0
def failed(error):
    raise error
for category in ('sessions', 'archived_sessions', 'native-files'):
    if not os.path.exists(category):
        continue
    if os.path.islink(category):
        raise ValueError('Conversation storage must not be a symlink')
    for directory, children, names in os.walk(category, onerror=failed, followlinks=False):
        if category != 'native-files':
            children[:] = [name for name in children if re.fullmatch(r'\d{2,4}', name)]
            if len(directory.split(os.sep)) > 4:
                children[:] = []
        for name in names:
            if category != 'native-files' and not (name.startswith('rollout-') and name.endswith('.jsonl')):
                continue
            path = os.path.join(directory, name)
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('Invalid conversation file')
            if category != 'native-files':
                with open(path, 'rb') as source:
                    metadata = json.loads(source.readline(64 * 1024 * 1024 + 1))
                payload = metadata.get('payload', {})
                if metadata.get('type') != 'session_meta' or payload.get('session_id', payload.get('id')) != thread:
                    continue
                rollout_bytes += info.st_size
                rollouts += 1
                if info.st_size > 64 * 1024 * 1024 or rollout_bytes > 256 * 1024 * 1024 or rollouts > 256:
                    raise ValueError('Native history exceeds its export limit')
            else:
                file_bytes += info.st_size
                files += 1
                if file_bytes > 64 * 1024 * 1024 or files > 256:
                    raise ValueError('Native files exceed their export limit')
            paths.append(path)
print(json.dumps(paths))
`;
const decodeFiles = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Copy the stopped workflow's native history through the existing UID boundary.
 * A virtual source view preserves absolute attachment paths without rewriting
 * native JSONL records or their byte offsets. Only staging is coordinator-owned.
 */
export const exportWorkflowCodexConversation = Effect.fn("exportWorkflowCodexConversation")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    input: Parameters<typeof exportCodexConversation>[0],
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.resolve(input.codexHome);
    const relative = path.relative(home, path.resolve(input.rolloutPath));
    const failure = () =>
      new CodexConversationTransferError({
        message: "The workflow's native conversation could not be read.",
      });
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.resolve(input.artifactRoot) === home ||
      path.resolve(input.artifactRoot).startsWith(`${home}${path.sep}`)
    )
      return yield* failure();
    const runner = yield* ProcessRunner.make().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const listing = yield* runner.run({
      command: "/usr/bin/python3",
      args: ["-IS", "-c", listConversationFiles, input.threadId],
      cwd: home,
      env: {},
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (listing.code !== 0) return yield* failure();
    const files = yield* decodeFiles(listing.stdout);
    if (
      !files.includes(relative) ||
      files.length > 512 ||
      files.some((file) => !/^(?:sessions|archived_sessions|native-files)\//u.test(file))
    )
      return yield* failure();
    yield* fs.makeDirectory(input.artifactRoot, { recursive: true, mode: 0o700 });
    const snapshot = yield* fs.makeTempDirectoryScoped({
      directory: input.artifactRoot,
      prefix: "codex-source-",
    });
    yield* stageWorkflowCheckpoint(spawner, home, snapshot, files);
    const source = (file: string) =>
      file === home
        ? snapshot
        : file.startsWith(`${home}${path.sep}`)
          ? path.join(snapshot, path.relative(home, file))
          : file;
    const original = (file: string) =>
      file === snapshot
        ? home
        : file.startsWith(`${snapshot}${path.sep}`)
          ? path.join(home, path.relative(snapshot, file))
          : file;
    const snapshotFs: FileSystem.FileSystem = {
      ...fs,
      exists: (file) => fs.exists(source(file)),
      stat: (file) => fs.stat(source(file)),
      realPath: (file) => fs.realPath(source(file)).pipe(Effect.map(original)),
      readFile: (file) => fs.readFile(source(file)),
      readFileString: (file, encoding) => fs.readFileString(source(file), encoding),
      readDirectory: (file) => fs.readDirectory(source(file)),
      stream: (file, options) => fs.stream(source(file), options),
      copyFile: (file, destination) => fs.copyFile(source(file), destination),
    };
    return yield* exportCodexConversation(input).pipe(
      Effect.provideService(FileSystem.FileSystem, snapshotFs),
    );
  },
  Effect.provideService(VmCoordinatorProcess, false),
  Effect.scoped,
);
