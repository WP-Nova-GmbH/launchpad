// @effect-diagnostics nodeBuiltinImport:off - Exercises the standalone Node template builder and its real HTTP boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import { Template } from "e2b";
import * as Schema from "effect/Schema";
import { describe, it, expect } from "vite-plus/test";
import {
  prepareTemplateContext,
  validateBuildTarget,
  validateTemplateResources,
} from "./e2b-build-template.mjs";

const decodeTemplate = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({ type: Schema.String, args: Schema.Array(Schema.Unknown) }),
      ),
    }),
  ),
);
const decodeCommand = Schema.decodeUnknownSync(Schema.String);
// oxlint-disable-next-line t3code/no-global-process-runtime -- The fixture executes a real POSIX shebang on the host.
const hostPlatform = NodeOS.platform();

describe("E2B runner build inputs", () => {
  it.skipIf(hostPlatform === "win32")(
    "executes the pinned SDK's parsed native shim step without losing shell quoting",
    async () => {
      const dockerfile = await NodeFSP.readFile(
        new URL("../../e2b/template/Dockerfile", import.meta.url),
        "utf8",
      );
      const template = decodeTemplate(
        await Template.toJSON(Template().fromDockerfile(dockerfile), false),
      );
      const steps = template.steps.filter(
        (step) => step.type === "RUN" && decodeCommand(step.args[0]).includes("codex-native.json"),
      );
      expect(steps).toHaveLength(1);
      const parsedCommand = decodeCommand(steps[0]!.args[0]);
      const fixture = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "runner-shim-")),
      );
      try {
        const prefix = fixture + "/node_modules/";
        const root = prefix + "@openai/codex";
        const optional = root + "/node_modules/@openai/codex-linux-arm64";
        const native = optional + "/vendor/aarch64-unknown-linux-musl/bin/codex";
        const shim = fixture + "/bin/codex";
        const manifest = fixture + "/manifest/codex-native.json";
        await NodeFSP.mkdir(NodePath.dirname(native), { recursive: true });
        await NodeFSP.mkdir(NodePath.dirname(shim));
        await NodeFSP.writeFile(root + "/package.json", JSON.stringify({ version: "0.159.3" }));
        await NodeFSP.writeFile(
          optional + "/package.json",
          JSON.stringify({ version: "0.159.3-linux-arm64" }),
        );
        await NodeFSP.writeFile(
          native,
          '#!/bin/sh\nif [ "$1" = --version ]; then printf "codex-cli 0.159.3\\n"; exit 0; fi\nprintf "%s\\n" "$$" "$1" "$CODEX_MANAGED_PACKAGE_ROOT" "$CODEX_MANAGED_BY_NPM" "${CODEX_MANAGED_BY_PNPM-unset}"\n',
          { mode: 0o755 },
        );
        const command = parsedCommand
          .replaceAll("/usr/local/lib/node_modules/", prefix)
          .replaceAll("/opt/launchpad", fixture + "/manifest")
          .replaceAll("/usr/local/bin/codex", shim);
        const environment = {
          PATH: `${NodePath.dirname(process.execPath)}:${fixture}/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
          CODEX_MANAGED_BY_PNPM: "stale",
        };
        await NodeFSP.writeFile(shim, "old shim", { mode: 0o755 });
        const setup = NodeChildProcess.spawnSync("/bin/sh", ["-c", command], {
          env: environment,
          encoding: "utf8",
        });
        expect(setup.status, setup.stderr).toBe(0);
        expect(setup.stdout.trim()).toBe("codex-cli 0.159.3");
        expect(JSON.parse(await NodeFSP.readFile(manifest, "utf8"))).toEqual({
          version: "0.159.3",
          executable: native,
          sha256: NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(native))
            .digest("hex"),
        });
        const launched = NodeChildProcess.spawnSync(shim, ["argument with spaces"], {
          env: environment,
          encoding: "utf8",
        });
        expect(launched.status, launched.stderr).toBe(0);
        expect(launched.stdout.trim().split("\n")).toEqual([
          String(launched.pid),
          "argument with spaces",
          root,
          "1",
          "unset",
        ]);
        // Wrong optional distribution must fail before exchanging either artifact.
        const manifestBefore = await NodeFSP.readFile(manifest);
        const shimBefore = await NodeFSP.readFile(shim);
        await NodeFSP.writeFile(
          optional + "/package.json",
          JSON.stringify({ version: "0.159.2-linux-arm64" }),
        );
        const rejected = NodeChildProcess.spawnSync("/bin/sh", ["-c", command], {
          env: environment,
          encoding: "utf8",
        });
        expect(rejected.status).not.toBe(0);
        expect(await NodeFSP.readFile(manifest)).toEqual(manifestBefore);
        expect(await NodeFSP.readFile(shim)).toEqual(shimBefore);
      } finally {
        await NodeFSP.rm(fixture, { recursive: true, force: true });
      }
    },
  );
  it("copies only the verified package, never sibling state or credentials", async () => {
    const source = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "runner-source-"));
    let context: string | undefined;
    try {
      const payload = Buffer.from("packaged archive fixture");
      const archive = NodePath.join(source, "release.tar.gz");
      await NodeFSP.writeFile(archive, payload);
      await NodeFSP.writeFile(NodePath.join(source, ".env"), "must stay on host");
      const hash = NodeCrypto.createHash("sha256").update(payload).digest("hex");
      context = await prepareTemplateContext(archive, hash);
      await NodeFSP.writeFile(archive, "replaced after staging");
      expect((await NodeFSP.readdir(context)).sort()).toEqual([
        "activity.py",
        "launchpad-workloads.service",
        "server.sha256",
        "server.tar.gz",
        "workload.py",
      ]);
      expect(await NodeFSP.readFile(NodePath.join(context, "server.tar.gz"))).toEqual(payload);
      expect(await NodeFSP.readFile(NodePath.join(context, "server.sha256"), "utf8")).toBe(
        `${hash}  server.tar.gz\n`,
      );
      await expect(prepareTemplateContext(archive, hash)).rejects.toThrow("does not match");
    } finally {
      if (context) await NodeFSP.rm(context, { recursive: true, force: true });
      await NodeFSP.rm(source, { recursive: true, force: true });
    }
  });
  it("requires an explicit API and keeps credentials out of URLs and receipts", () => {
    expect(validateBuildTarget("http://127.0.0.1:3000/", "launchpad-arm64")).toBe(
      "http://127.0.0.1:3000",
    );
    for (const url of ["", "file:///tmp/api", "https://secret@host/", "https://host/?token=secret"])
      expect(() => validateBuildTarget(url, "launchpad")).toThrow();
    expect(() => validateBuildTarget("https://host", "../another-template")).toThrow();
  });
});

describe("runner template resources", () => {
  it("rejects invalid resource manifests before requesting a build", () => {
    for (const input of [
      undefined,
      {},
      { cpuCount: 2, memoryMB: 4096, minFreeDiskMb: 0 },
      { cpuCount: 0.5, memoryMB: 4096, minFreeDiskMb: 20480 },
    ])
      expect(() => validateTemplateResources(input)).toThrow("positive integer");
  });

  it("sends the free-disk target through the pinned SDK to E2B", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const server = NodeHttp.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const path = request.url ?? "";
      requests.push({ path, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (path === "/v3/templates") {
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            templateID: "fixture-template",
            buildID: "fixture-build",
            tags: ["fixture"],
          }),
        );
      } else {
        response.writeHead(
          path === "/v2/templates/fixture-template/builds/fixture-build" ? 202 : 404,
        );
        response.end("{}");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    try {
      const resources = validateTemplateResources({
        cpuCount: 2,
        memoryMB: 4096,
        minFreeDiskMb: 20480,
      });
      const result = await Template.buildInBackground(
        Template().fromImage("debian:bookworm-slim"),
        "fixture",
        {
          apiUrl: `http://127.0.0.1:${address.port}`,
          apiKey: "fixture-key",
          tags: ["fixture"],
          ...resources,
        },
      );
      expect(requests[0]).toEqual({
        path: "/v3/templates",
        body: { name: "fixture", tags: ["fixture"], ...resources },
      });
      expect(requests).toHaveLength(2);
      expect(result.templateId).toBe("fixture-template");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
