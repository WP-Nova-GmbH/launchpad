// @effect-diagnostics nodeBuiltinImport:off - Exercises the standalone Node template builder and its real HTTP boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import { Template } from "e2b";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import {
  buildTemplate,
  prepareTemplateContext,
  validateBuildTarget,
} from "./e2b-build-template.mjs";
import { loadDevThreadVmRuntimeSettings } from "./dev-thread-vm-template.ts";

const { buildMock } = vi.hoisted(() => ({ buildMock: vi.fn<typeof Template.build>() }));
vi.mock("e2b", async (original) => {
  const sdk = await original<typeof import("e2b")>();
  return {
    ...sdk,
    Template: new Proxy(sdk.Template, {
      get: (target, property, receiver) =>
        property === "build" ? buildMock : Reflect.get(target, property, receiver),
    }),
  };
});

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
const decodeJsonObject = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
// oxlint-disable-next-line t3code/no-global-process-runtime -- The fixture executes a real POSIX shebang on the host.
const hostPlatform = NodeOS.platform();

afterEach(() => {
  buildMock.mockReset();
  vi.unstubAllEnvs();
});

async function buildFixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "runner-build-"));
  const archive = NodePath.join(directory, "release.tar.gz");
  const payload = Buffer.from("packaged archive fixture");
  await NodeFSP.writeFile(archive, payload);
  const selected = NodePath.join(directory, "active", "template.json");
  vi.stubEnv("E2B_TEMPLATE_FILE", selected);
  vi.stubEnv("E2B_API_URL", "http://127.0.0.1:3000/");
  return {
    directory,
    selected,
    args: {
      "server-archive": archive,
      "server-sha256": NodeCrypto.createHash("sha256").update(payload).digest("hex"),
      output: NodePath.join(directory, "receipts", "build.json"),
    },
  };
}

describe("runner build publication", () => {
  it("rejects a relative selected-template path before requesting a build", async () => {
    const fixture = await buildFixture();
    try {
      vi.stubEnv("E2B_TEMPLATE_FILE", " .t3/template.json ");
      await expect(buildTemplate(fixture.args, "fixture-key")).rejects.toThrow(
        "must be an absolute path",
      );
      expect(buildMock).not.toHaveBeenCalled();
      await expect(NodeFSP.readFile(fixture.args.output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("loads the relay .env with environment precedence and creates unique default receipts beside the script", async () => {
    const fixture = await buildFixture();
    try {
      const relay = NodePath.join(fixture.directory, "infra", "relay");
      const scripts = NodePath.join(relay, "scripts");
      await NodeFSP.mkdir(scripts, { recursive: true });
      await NodeFSP.cp(
        new URL("../../e2b/template/", import.meta.url),
        NodePath.join(fixture.directory, "infra", "e2b", "template"),
        { recursive: true },
      );
      const source = await NodeFSP.readFile(
        new URL("./e2b-build-template.mjs", import.meta.url),
        "utf8",
      );
      const entrypoint = NodePath.join(scripts, "e2b-build-template.mjs");
      await NodeFSP.writeFile(entrypoint, source.replace('from "e2b"', 'from "./sdk.mjs"'));
      await NodeFSP.writeFile(
        NodePath.join(scripts, "sdk.mjs"),
        `
        export function Template() { return { fromDockerfile() { return {}; } }; }
        Template.build = async (_template, name, options) => ({
          templateId: "cli-template", buildId: "cli-build", name, alias: name, tags: options.tags,
        });
      `,
      );
      await NodeFSP.writeFile(
        NodePath.join(relay, ".env"),
        "E2B_API_URL=http://127.0.0.1:3000\nE2B_API_KEY=fixture-key\n",
      );
      for (const apiUrl of [undefined, "http://127.0.0.1:9000"]) {
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [
            entrypoint,
            "--server-archive",
            fixture.args["server-archive"],
            "--server-sha256",
            fixture.args["server-sha256"],
          ],
          {
            cwd: fixture.directory,
            env: { E2B_TEMPLATE_FILE: " ", ...(apiUrl ? { E2B_API_URL: apiUrl } : {}) },
            encoding: "utf8",
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const selected = JSON.parse(
          await NodeFSP.readFile(NodePath.join(relay, ".t3", "e2b-template.json"), "utf8"),
        );
        expect(selected.apiUrl).toBe(apiUrl ?? "http://127.0.0.1:3000");
        expect(selected.state).toBe("built");
      }
      const receipts = await NodeFSP.readdir(NodePath.join(relay, ".t3", "e2b-builds"));
      expect(receipts).toHaveLength(2);
      for (const path of receipts) {
        const receipt = JSON.parse(
          await NodeFSP.readFile(NodePath.join(relay, ".t3", "e2b-builds", path), "utf8"),
        );
        expect(receipt.name).toBe("launchpad-arm64");
      }
      await expect(NodeFSP.readdir(NodePath.join(fixture.directory, ".t3"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await NodeFSP.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  effectIt.effect("publishes a successful immutable build that the relay can load", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* Effect.acquireRelease(Effect.promise(buildFixture), (fixture) =>
          Effect.promise(() => NodeFSP.rm(fixture.directory, { recursive: true, force: true })),
        );
        const { selected, receipt } = yield* Effect.promise(async () => {
          const build = buildMock.mockImplementation(async (...args: unknown[]) => {
            const options = args[2] as { tags: string[] };
            const receipt = JSON.parse(await NodeFSP.readFile(fixture.args.output, "utf8"));
            expect(receipt.state).toBe("building");
            await expect(NodeFSP.readFile(fixture.selected)).rejects.toMatchObject({
              code: "ENOENT",
            });
            return {
              alias: "launchpad-arm64",
              name: "launchpad-arm64",
              templateId: "fixture-template",
              buildId: "fixture-build",
              tags: options.tags,
            };
          });
          await buildTemplate(fixture.args, "fixture-key");
          expect(build).toHaveBeenCalledWith(
            expect.anything(),
            "launchpad-arm64",
            expect.objectContaining({
              apiUrl: "http://127.0.0.1:3000",
              cpuCount: 2,
              memoryMB: 4096,
              minFreeDiskMb: 21504,
            }),
          );
          const selected = await NodeFSP.readFile(fixture.selected, "utf8");
          const receipt = decodeJsonObject(await NodeFSP.readFile(fixture.args.output, "utf8"));
          expect(decodeJsonObject(selected)).toEqual({
            schemaVersion: 1,
            state: "built",
            apiUrl: "http://127.0.0.1:3000",
            templateRef: `fixture-template:${receipt.buildTag}`,
            buildId: "fixture-build",
          });
          expect(receipt).toMatchObject({
            state: "built",
            templateId: "fixture-template",
            serverSha256: fixture.args["server-sha256"],
            resources: {
              cpuCount: 2,
              memoryMB: 4096,
              minFreeDiskMb: 21504,
              minUsableDiskMb: 20480,
            },
          });
          for (const field of [
            "dockerfileSha256",
            "activitySha256",
            "workloadSha256",
            "workloadServiceSha256",
          ])
            expect(receipt[field]).toMatch(/^[a-f0-9]{64}$/);
          expect(await NodeFSP.readdir(NodePath.dirname(fixture.selected))).toEqual([
            "template.json",
          ]);
          return { selected, receipt };
        });
        const settings = yield* loadDevThreadVmRuntimeSettings.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: (path) =>
                path === fixture.selected
                  ? Effect.succeed(selected)
                  : Effect.die(new Error("Unexpected selection path")),
            }),
          ),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                RELAY_THREAD_VM_PROVISIONING_ENABLED: true,
                E2B_API_URL: "http://127.0.0.1:3000",
                E2B_SANDBOX_URL: "http://127.0.0.1:3002",
                E2B_API_KEY: "fixture-key",
                E2B_TEMPLATE_FILE: fixture.selected,
                E2B_HOST_ID: "fixture-host",
                E2B_MAX_RUNNING_VMS: 2,
                E2B_PUBLIC_RELAY_URL: "https://relay.example.com",
                E2B_HOST_ADDRESSES: "192.0.2.10",
              }),
            ),
          ),
        );
        expect(settings?.compute.templateId).toBe(receipt.templateRef);
        expect(settings?.templateBuildId).toBe(receipt.buildId);
      }),
    ),
  );

  it.each([
    { templateId: "" },
    { templateId: "bad:template" },
    { buildId: "bad/build" },
    { tags: ["another-build"] },
  ])("preserves the prior selection when a completed build is malformed: %j", async (invalid) => {
    const fixture = await buildFixture();
    try {
      await NodeFSP.mkdir(NodePath.dirname(fixture.selected));
      const previous = '{"state":"built","templateRef":"previous:build-keep"}\n';
      await NodeFSP.writeFile(fixture.selected, previous);
      buildMock.mockImplementation(async (...args: unknown[]) => ({
        alias: "launchpad-arm64",
        name: "launchpad-arm64",
        templateId: "fixture-template",
        buildId: "fixture-build",
        tags: (args[2] as { tags: string[] }).tags,
        ...invalid,
      }));
      await expect(buildTemplate(fixture.args, "fixture-key")).rejects.toThrow(
        "invalid template identity",
      );
      expect(await NodeFSP.readFile(fixture.selected, "utf8")).toBe(previous);
      expect(JSON.parse(await NodeFSP.readFile(fixture.args.output, "utf8")).state).toBe(
        "building",
      );
    } finally {
      await NodeFSP.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("preserves the prior selection and diagnostic receipt when E2B fails", async () => {
    const fixture = await buildFixture();
    try {
      await NodeFSP.mkdir(NodePath.dirname(fixture.selected));
      const previous = '{"state":"built","templateRef":"previous:build-keep"}\n';
      await NodeFSP.writeFile(fixture.selected, previous);
      buildMock.mockRejectedValue(new Error("fixture build failed"));
      await expect(buildTemplate(fixture.args, "fixture-key")).rejects.toThrow(
        "fixture build failed",
      );
      expect(await NodeFSP.readFile(fixture.selected, "utf8")).toBe(previous);
      expect(JSON.parse(await NodeFSP.readFile(fixture.args.output, "utf8")).state).toBe(
        "building",
      );
    } finally {
      await NodeFSP.rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

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
      const resources = {
        cpuCount: 2,
        memoryMB: 4096,
        minFreeDiskMb: 21504,
      };
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
