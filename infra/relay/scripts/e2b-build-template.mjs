import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { Template } from "e2b";

const templateDirectory = NodeURL.fileURLToPath(new URL("../../e2b/template/", import.meta.url));

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

// Keep the standard size in the operator-owned template manifest. The pinned
// SDK patch forwards minFreeDiskMb to E2B's existing template-build API.
export function validateTemplateResources(resources) {
  const { cpuCount, memoryMB, minFreeDiskMb } = resources ?? {};
  if (
    ![cpuCount, memoryMB, minFreeDiskMb].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error(
      "Template resources must specify positive integer cpuCount, memoryMB and minFreeDiskMb.",
    );
  return { cpuCount, memoryMB, minFreeDiskMb };
}

export async function buildTemplate(args, apiKey) {
  const apiUrl = validateBuildTarget(args["api-url"], args.name);
  if (!apiKey?.trim()) throw new Error("E2B_API_KEY is required on the build host.");
  const context = await prepareTemplateContext(args["server-archive"], args["server-sha256"]);
  try {
    const dockerfile = await NodeFSP.readFile(
      NodePath.join(templateDirectory, "Dockerfile"),
      "utf8",
    );
    const versions = JSON.parse(
      await NodeFSP.readFile(NodePath.join(templateDirectory, "versions.json"), "utf8"),
    );
    validateTemplateResources(versions.resources);
    const usableDisk = versions.resources.minUsableDiskMb;
    if (
      !Number.isSafeInteger(usableDisk) ||
      usableDisk <= 0 ||
      usableDisk > versions.resources.minFreeDiskMb
    )
      throw new Error(
        "Specify a positive usable disk minimum no greater than the E2B growth target.",
      );
    const buildTag = `build-${NodeCrypto.randomUUID()}`;
    const manifest = {
      schemaVersion: 1,
      buildTag,
      state: "building",
      apiUrl,
      name: args.name,
      versions,
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
    await NodeFSP.writeFile(args.output, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const template = Template({ fileContextPath: context }).fromDockerfile(dockerfile);
    const result = await Template.build(template, args.name, {
      apiUrl,
      apiKey,
      ...validateTemplateResources(versions.resources),
      tags: [buildTag],
      skipCache: args["skip-cache"] === true,
      onBuildLogs: (entry) => process.stdout.write(`${entry}\n`),
    });
    await NodeFSP.writeFile(
      args.output,
      `${JSON.stringify({ ...manifest, state: "built", ...result, templateRef: `${result.templateId}:${buildTag}` }, null, 2)}\n`,
    );
    return result;
  } finally {
    await NodeFSP.rm(context, { recursive: true, force: true });
  }
}

if (import.meta.main) {
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
  if (
    ["api-url", "name", "server-archive", "server-sha256", "output"].some((key) => !values[key])
  ) {
    process.stderr.write(
      "Required: --api-url --name --server-archive --server-sha256 --output (new manifest file). Optional: --skip-cache. Set E2B_API_KEY only on the build host.\n",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await buildTemplate(values, process.env.E2B_API_KEY);
      process.stdout.write(
        `Built ${result.templateId}/${result.buildId}. Verify it before configuring the relay.\n`,
      );
    } catch (error) {
      process.stderr.write(
        `Launchpad template build failed (${error?.name ?? "Error"}). Inspect the saved receipt and E2B build logs; credentials were not printed.\n`,
      );
      process.exitCode = 1;
    }
  }
}
