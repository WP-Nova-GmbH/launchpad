import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { Template } from "e2b";

const templateDirectory = NodeURL.fileURLToPath(new URL("../../e2b/template/", import.meta.url));
const relayDirectory = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const standardResources = {
  cpuCount: 2,
  memoryMB: 4096,
  minFreeDiskMb: 21504,
  minUsableDiskMb: 20480,
};

async function writeJsonAtomically(path, value) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export async function prepareTemplateContext(archive, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error("A lowercase SHA-256 checksum is required.");
  const context = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "launchpad-template-"));
  try {
    // Hash the copied bytes that will actually be uploaded, not a source file
    // which another build could replace between verification and upload.
    await NodeFSP.copyFile(archive, NodePath.join(context, "server.tar.gz"));
    const digest = NodeCrypto.createHash("sha256");
    for await (const chunk of NodeFS.createReadStream(NodePath.join(context, "server.tar.gz")))
      digest.update(chunk);
    if (digest.digest("hex") !== expectedSha256)
      throw new Error("The packaged server archive does not match its checksum.");
    await NodeFSP.writeFile(
      NodePath.join(context, "server.sha256"),
      `${expectedSha256}  server.tar.gz\n`,
      { mode: 0o600 },
    );
    for (const file of ["workload.py", "activity.py", "launchpad-workloads.service"])
      await NodeFSP.copyFile(NodePath.join(templateDirectory, file), NodePath.join(context, file));
    return context;
  } catch (error) {
    await NodeFSP.rm(context, { recursive: true, force: true });
    throw error;
  }
}

export function validateBuildTarget(apiUrl, name) {
  const url = new URL(apiUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Provide an explicit self-hosted E2B HTTP(S) API URL without embedded credentials.",
    );
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
    throw new Error("Use a lowercase template name of at most 63 letters, digits or hyphens.");
  return url.href.replace(/\/$/, "");
}

export async function buildTemplate(args, apiKey) {
  const name = args.name ?? "launchpad-arm64";
  const apiUrl = validateBuildTarget(args["api-url"] ?? process.env.E2B_API_URL, name);
  if (!apiKey?.trim()) throw new Error("E2B_API_KEY is required on the build host.");
  const buildTag = `build-${NodeCrypto.randomUUID()}`;
  const output = NodePath.resolve(
    args.output ?? NodePath.join(relayDirectory, ".t3", "e2b-builds", `${buildTag}.json`),
  );
  const selectedFile = process.env.E2B_TEMPLATE_FILE?.trim();
  if (selectedFile && !NodePath.isAbsolute(selectedFile))
    throw new Error("E2B_TEMPLATE_FILE must be an absolute path.");
  const selectionPath = NodePath.resolve(
    selectedFile || NodePath.join(relayDirectory, ".t3", "e2b-template.json"),
  );
  if (output === selectionPath)
    throw new Error("The build receipt and selected template must use separate files.");
  const context = await prepareTemplateContext(args["server-archive"], args["server-sha256"]);
  try {
    const dockerfile = await NodeFSP.readFile(
      NodePath.join(templateDirectory, "Dockerfile"),
      "utf8",
    );
    const manifest = {
      schemaVersion: 1,
      buildTag,
      state: "building",
      apiUrl,
      name,
      resources: standardResources,
      skipCache: args["skip-cache"] === true,
      serverSha256: args["server-sha256"],
      activitySha256: NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(NodePath.join(context, "activity.py")))
        .digest("hex"),
      workloadSha256: NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(NodePath.join(context, "workload.py")))
        .digest("hex"),
      workloadServiceSha256: NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(NodePath.join(context, "launchpad-workloads.service")))
        .digest("hex"),
      dockerfileSha256: NodeCrypto.createHash("sha256").update(dockerfile).digest("hex"),
    };
    // Reserve a new local receipt before the remote operation. On failure retain
    // it so the operator can inspect that exact template instead of guessing.
    await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const template = Template({ fileContextPath: context }).fromDockerfile(dockerfile);
    const result = await Template.build(template, name, {
      apiUrl,
      apiKey,
      cpuCount: standardResources.cpuCount,
      memoryMB: standardResources.memoryMB,
      // The pinned SDK patch forwards this to E2B's template-build API.
      minFreeDiskMb: standardResources.minFreeDiskMb,
      tags: [buildTag],
      skipCache: args["skip-cache"] === true,
      onBuildLogs: (entry) => process.stdout.write(`${entry}\n`),
    });
    if (
      !result ||
      ![result.templateId, result.buildId].every(
        (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value),
      ) ||
      !Array.isArray(result.tags) ||
      !result.tags.includes(buildTag)
    )
      throw new Error("The completed build returned an invalid template identity.");
    const selection = {
      schemaVersion: 1,
      state: "built",
      apiUrl,
      templateRef: `${result.templateId}:${buildTag}`,
      buildId: result.buildId,
    };
    await writeJsonAtomically(output, { ...result, ...manifest, ...selection });
    await writeJsonAtomically(selectionPath, selection);
    return result;
  } finally {
    await NodeFSP.rm(context, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const environmentFile = NodePath.join(relayDirectory, ".env");
  if (NodeFS.existsSync(environmentFile)) process.loadEnvFile(environmentFile);
  const { values } = NodeUtil.parseArgs({
    options: {
      "skip-cache": { type: "boolean", default: false },
      ...Object.fromEntries(
        ["api-url", "name", "server-archive", "server-sha256", "output"].map((key) => [
          key,
          { type: "string" },
        ]),
      ),
    },
  });
  if (["server-archive", "server-sha256"].some((key) => !values[key])) {
    process.stderr.write(
      "Required: --server-archive --server-sha256. Optional: --api-url (defaults to E2B_API_URL), --name (launchpad-arm64), --output (new build receipt), --skip-cache. Configure E2B_API_KEY in infra/relay/.env or the build environment.\n",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await buildTemplate(values, process.env.E2B_API_KEY);
      process.stdout.write(
        `Built and selected ${result.templateId}/${result.buildId}. The relay will use it on restart.\n`,
      );
    } catch (error) {
      process.stderr.write(
        `Launchpad template build failed (${error?.name ?? "Error"}). Inspect the saved receipt and E2B build logs; credentials were not printed.\n`,
      );
      process.exitCode = 1;
    }
  }
}
