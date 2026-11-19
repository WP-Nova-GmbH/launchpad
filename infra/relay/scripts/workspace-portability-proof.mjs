// Disposable fixture only. No account, provider home, or real checkout is read.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
const platform = Effect.runSync(HostProcessPlatform);
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer as ProcessRunnerLayer } from "../../../apps/server/src/processRunner.ts";
import {
  exportThreadWorkspace,
  importThreadWorkspace,
  ThreadWorkspaceManifest,
} from "../../../apps/server/src/relay/ThreadWorkspaceTransfer.ts";
import * as Schema from "effect/Schema";
import { attachmentRelativePath } from "../../../apps/server/src/attachmentStore.ts";
import {
  exportThreadAttachments,
  importThreadAttachments,
  ThreadAttachmentManifest,
} from "../../../apps/server/src/relay/ThreadAttachmentTransfer.ts";

const Input = Schema.Struct({
  action: Schema.Literals(["source", "resume"]),
  root: Schema.NonEmptyString,
  source: Schema.optionalKey(
    Schema.Struct({
      manifest: ThreadWorkspaceManifest,
      objects: Schema.Record(Schema.String, Schema.String),
      expectedHead: Schema.String,
      attachments: Schema.Struct({
        manifest: ThreadAttachmentManifest,
        objects: Schema.Record(Schema.String, Schema.String),
      }),
    }),
  ),
});
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("Fixture exceeds 16 MiB");
}
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(raw);
NodeAssert.ok(NodePath.isAbsolute(input.root));
await NodeFSP.mkdir(input.root, { mode: 0o700 });
const run = (effect) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(ProcessRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
const git = (cwd, args) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_AUTHOR_NAME: "Proof",
      GIT_AUTHOR_EMAIL: "proof@localhost",
      GIT_COMMITTER_NAME: "Proof",
      GIT_COMMITTER_EMAIL: "proof@localhost",
    },
  })
    .toString()
    .trim();
let workspace, expectedHead;
let attachmentsDir;
const attachmentBytes = [
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==",
    "base64",
  ),
  Buffer.from("Launchpad attachment retained across the move.\n"),
];
const attachments = [
  {
    type: "image",
    id: "workspace-proof-00000000-0000-4000-8000-000000000001",
    name: "picture.png",
    mimeType: "image/png",
    sizeBytes: attachmentBytes[0].length,
  },
  {
    type: "file",
    id: "workspace-proof-00000000-0000-4000-8000-000000000002-txt",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: attachmentBytes[1].length,
  },
];
if (input.action === "source") {
  attachmentsDir = NodePath.join(input.root, "attachments");
  await NodeFSP.mkdir(attachmentsDir);
  for (const [index, attachment] of attachments.entries())
    await NodeFSP.writeFile(
      NodePath.join(attachmentsDir, attachmentRelativePath(attachment)),
      attachmentBytes[index],
      { mode: 0o600, flag: "wx" },
    );
  await NodeFSP.writeFile(NodePath.join(attachmentsDir, "unrelated.txt"), "another thread's file");
  workspace = NodePath.join(input.root, "workspace");
  await NodeFSP.mkdir(workspace);
  git(workspace, ["init", "-b", "workspace-proof"]);
  await NodeFSP.writeFile(NodePath.join(workspace, "README.txt"), "committed\n");
  await NodeFSP.writeFile(
    NodePath.join(workspace, ".gitignore"),
    "ignored/\nnode_modules/\n.t3/\n*.sqlite*\n",
  );
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "Disposable workspace proof"]);
  expectedHead = git(workspace, ["rev-parse", "HEAD"]);
  await NodeFSP.writeFile(NodePath.join(workspace, "README.txt"), "staged\n");
  git(workspace, ["add", "README.txt"]);
  await NodeFSP.writeFile(NodePath.join(workspace, "README.txt"), "unstaged\n");
  await NodeFSP.mkdir(NodePath.join(workspace, "ignored"));
  await NodeFSP.writeFile(NodePath.join(workspace, "ignored", "local.txt"), "ignored data\n");
  await NodeFSP.writeFile(NodePath.join(workspace, "run.sh"), "#!/bin/sh\nprintf executable-ok\n", {
    mode: 0o755,
  });
  await NodeFSP.symlink("README.txt", NodePath.join(workspace, "readme-link"));
  for (const directory of ["node_modules", ".t3"]) {
    await NodeFSP.mkdir(NodePath.join(workspace, directory));
    await NodeFSP.writeFile(NodePath.join(workspace, directory, "excluded"), "never copy");
  }
  const db = new NodeSqlite.DatabaseSync(NodePath.join(workspace, "database.sqlite"));
  try {
    db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('retained');");
  } finally {
    db.close();
  }
} else {
  NodeAssert.ok(input.source);
  const artifact = NodePath.join(input.root, "incoming");
  await NodeFSP.mkdir(artifact);
  await NodeFSP.mkdir(NodePath.join(artifact, "objects"));
  for (const [name, bytes] of Object.entries(input.source.objects)) {
    NodeAssert.ok(
      name === "index" || name === "repository.bundle" || /^objects\/[0-9a-f]{64}$/.test(name),
    );
    await NodeFSP.writeFile(NodePath.join(artifact, name), Buffer.from(bytes, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const restored = await run(
    importThreadWorkspace({
      threadId: "workspace-proof",
      manifest: input.source.manifest,
      artifactDirectory: artifact,
      destinationRoot: NodePath.join(input.root, "checkouts"),
    }),
  );
  workspace = restored.workspaceRoot;
  expectedHead = input.source.expectedHead;
  const incomingAttachments = NodePath.join(input.root, "incoming-attachments");
  await NodeFSP.mkdir(incomingAttachments);
  const allowedNames = new Set(attachments.map(attachmentRelativePath));
  for (const [name, data] of Object.entries(input.source.attachments.objects)) {
    NodeAssert.ok(allowedNames.has(name), "Unexpected attachment object");
    await NodeFSP.writeFile(NodePath.join(incomingAttachments, name), Buffer.from(data, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const importedAttachments = await run(
    importThreadAttachments({
      threadId: "workspace-proof",
      attachments,
      manifest: input.source.attachments.manifest,
      artifactDirectory: incomingAttachments,
      destinationRoot: NodePath.join(input.root, "attachment-store"),
    }),
  );
  attachmentsDir = importedAttachments.attachmentsDir;
}
for (const [index, attachment] of attachments.entries())
  NodeAssert.deepEqual(
    await NodeFSP.readFile(NodePath.join(attachmentsDir, attachmentRelativePath(attachment))),
    attachmentBytes[index],
  );
if (input.action === "resume")
  await NodeAssert.rejects(NodeFSP.stat(NodePath.join(attachmentsDir, "unrelated.txt")), {
    code: "ENOENT",
  });
NodeAssert.equal(git(workspace, ["rev-parse", "HEAD"]), expectedHead);
NodeAssert.equal(git(workspace, ["branch", "--show-current"]), "workspace-proof");
NodeAssert.equal(git(workspace, ["show", ":README.txt"]), "staged");
NodeAssert.equal(
  await NodeFSP.readFile(NodePath.join(workspace, "README.txt"), "utf8"),
  "unstaged\n",
);
NodeAssert.equal(
  await NodeFSP.readFile(NodePath.join(workspace, "ignored", "local.txt"), "utf8"),
  "ignored data\n",
);
NodeAssert.equal(await NodeFSP.readlink(NodePath.join(workspace, "readme-link")), "README.txt");
NodeAssert.equal(
  NodeChildProcess.execFileSync(NodePath.join(workspace, "run.sh")).toString(),
  "executable-ok",
);
const database = new NodeSqlite.DatabaseSync(NodePath.join(workspace, "database.sqlite"), {
  readOnly: true,
});
try {
  NodeAssert.equal(database.prepare("SELECT value FROM proof").get()?.value, "retained");
  NodeAssert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
} finally {
  database.close();
}
if (input.action === "resume") {
  for (const name of ["node_modules", ".t3"])
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(workspace, name)), { code: "ENOENT" });
}
await NodeFSP.writeFile(
  NodePath.join(workspace, `visited-${platform}.txt`),
  "destination edit retained\n",
);
const artifact = await run(
  exportThreadWorkspace({
    threadId: "workspace-proof",
    workspaceRoot: workspace,
    artifactRoot: NodePath.join(input.root, "artifacts"),
  }),
);
const names = [
  "index",
  "repository.bundle",
  ...new Set(
    artifact.manifest.files
      .filter((file) => file.kind === "file")
      .map((file) => `objects/${file.sha256}`),
  ),
];
const objects = {};
for (const name of names)
  objects[name] = (await NodeFSP.readFile(NodePath.join(artifact.directory, name))).toString(
    "base64",
  );
const attachmentArtifact = await run(
  exportThreadAttachments({
    threadId: "workspace-proof",
    attachments,
    attachmentsDir,
    artifactRoot: NodePath.join(input.root, "attachment-artifacts"),
  }),
);
const attachmentObjects = {};
for (const attachment of attachments) {
  const name = attachmentRelativePath(attachment);
  attachmentObjects[name] = (
    await NodeFSP.readFile(NodePath.join(attachmentArtifact.directory, name))
  ).toString("base64");
}
const result = {
  manifest: artifact.manifest,
  objects,
  expectedHead,
  platform: platform,
  stagedAndUnstagedPreserved: true,
  ignoredPreserved: true,
  executablePreserved: true,
  symlinkPreserved: true,
  sqliteVerified: true,
  launchpadAttachmentsVerified: true,
  attachments: { manifest: attachmentArtifact.manifest, objects: attachmentObjects },
};
await NodeFSP.writeFile(NodePath.join(input.root, "result.json"), JSON.stringify(result) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  JSON.stringify({
    platform: platform,
    workspaceTransferred: true,
    sqliteVerified: true,
    launchpadAttachmentsVerified: true,
  }),
);
