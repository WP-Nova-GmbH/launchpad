// @effect-diagnostics nodeBuiltinImport:off - Exercises the standalone smoke publisher with an offline SDK boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { workflowVmModelProofPath } from "../src/threads/ThreadVmWorkflowModelProof.ts";

const legacyChecks = {
  workflowEnrollment: true,
  workflowLauncher: true,
  coordinatorCredentialsProtected: true,
  coordinatorSignallingDenied: true,
  reviewGitProtected: true,
  privilegedControlDenied: true,
  envdRootCommandDenied: true,
  envdRootFileReadDenied: true,
  workspaceWritable: true,
  detachedWorkloadStopped: true,
  unrelatedWorkloadPreserved: true,
  setupOwnerVerified: true,
  nativeCodexPeerVerified: true,
  otherCodexPeersDenied: true,
  privateCheckpointReaderVerified: true,
};
const executionChecks = {
  workflowRecoveryInspectionVerified: true,
  nativeCodexCommandExecuted: true,
  nativeCodexApprovalDenied: true,
  nativeCodexResumeExecuted: true,
  nativeCodexDumpabilityProtected: true,
  nativeCodexStartupHooksExecuted: true,
  nativeCodexWorkloadsStopped: true,
};

async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "runner-smoke-"));
  const receipt = {
    state: "built",
    apiUrl: "http://127.0.0.1:3000",
    templateId: "fixture",
    buildTag: "build-00000000-0000-4000-8000-000000000001",
    buildId: "fixture-build",
    templateRef: "fixture:build-00000000-0000-4000-8000-000000000001",
    resources: { cpuCount: 2, memoryMB: 4096, minFreeDiskMb: 21504 },
    workloadSha256: "a".repeat(64),
    workloadServiceSha256: "b".repeat(64),
    installerSha256: "c".repeat(64),
    workflowExecSha256: "d".repeat(64),
    workflowCheckpointReaderSha256: "e".repeat(64),
  };
  const selected = NodePath.join(directory, "template.json");
  const published = workflowVmModelProofPath(selected, receipt.buildId);
  await NodeFSP.writeFile(NodePath.join(directory, "receipt.json"), JSON.stringify(receipt));
  await NodeFSP.writeFile(NodePath.join(directory, "key"), "offline-fixture-key", { mode: 0o600 });
  await NodeFSP.writeFile(
    NodePath.join(directory, "hooks.mjs"),
    `import { registerHooks } from 'node:module';
     registerHooks({ resolve(specifier, context, next) {
       return specifier === 'e2b'
         ? { url: new URL('./sdk.mjs', import.meta.url).href, shortCircuit: true }
         : next(specifier, context);
     }});`,
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "sdk.mjs"),
    `import * as fs from 'node:fs/promises';
     const input = JSON.parse(await fs.readFile(process.env.SMOKE_FIXTURE, 'utf8'));
     const published = process.env.SMOKE_PUBLISHED;
     let metadata;
     let tagReads = 0;
     export class SandboxNotFoundError extends Error {}
     export class CommandExitError extends Error {}
     export class Template {
       static async getTags() {
         tagReads++;
         return [{ tag: input.receipt.buildTag,
           buildId: input.tagChanged && tagReads > 1 ? 'different-build' : input.receipt.buildId }];
       }
     }
     export class Sandbox {
       static async create(_, options) {
         metadata = options.metadata;
         return { sandboxId: 'owned-smoke-vm', commands: { run: async (command) => ({
           exitCode: 0,
           stdout: command.includes('runner-build-tag') ? input.receipt.buildTag + '\\n'
             : command.includes('WORKFLOW_ISOLATION_PROOF') ? JSON.stringify(input.checks)
             : command.includes('WORKFLOW_MODEL_PROOF') ? JSON.stringify({
                 defaultModel: 'gpt-6-astra', models: [{ slug: 'gpt-6-astra', name: 'GPT-6 Astra' }] })
             : '{}',
         }) }};
       }
       static list() { return { hasNext: false }; }
       static async getInfo() { return { metadata }; }
       static async kill() {
         const publishedBeforeCleanup = await fs.stat(published).then(() => true, () => false);
         await fs.writeFile(process.env.SMOKE_CLEANUP, JSON.stringify({ publishedBeforeCleanup }));
         if (input.cleanupFails) throw new Error('fixture cleanup unavailable');
       }
     }`,
  );
  let attempt = 0;
  return {
    published,
    async run(
      checks: Record<string, boolean>,
      options: { isolation?: boolean; cleanupFails?: boolean; tagChanged?: boolean } = {},
    ) {
      const input = NodePath.join(directory, `input-${attempt}.json`);
      const output = NodePath.join(directory, `output-${attempt++}`);
      const cleanup = `${output}-cleanup.json`;
      await NodeFSP.writeFile(input, JSON.stringify({ receipt, checks, ...options }));
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--import",
          NodePath.join(directory, "hooks.mjs"),
          NodeURL.fileURLToPath(new URL("./e2b-runner-smoke.mjs", import.meta.url)),
          "--receipt",
          NodePath.join(directory, "receipt.json"),
          "--output",
          output,
          ...(options.isolation === false ? [] : ["--workflow-isolation"]),
        ],
        {
          cwd: directory,
          env: {
            E2B_API_URL: receipt.apiUrl,
            E2B_SANDBOX_URL: "http://127.0.0.1:3002",
            E2B_API_KEY_FILE: NodePath.join(directory, "key"),
            E2B_TEMPLATE_FILE: selected,
            SMOKE_FIXTURE: input,
            SMOKE_PUBLISHED: published,
            SMOKE_CLEANUP: cleanup,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      return {
        result,
        cleanup: JSON.parse(await NodeFSP.readFile(cleanup, "utf8")),
        output,
      };
    },
    readPublished: async () => JSON.parse(await NodeFSP.readFile(published, "utf8")),
    close: () => NodeFSP.rm(directory, { recursive: true, force: true }),
  };
}

describe("workflow isolation publication", () => {
  it("rejects the old model-only evidence and every missing or failed command check", async () => {
    const test = await fixture();
    try {
      const complete = { ...legacyChecks, ...executionChecks };
      const incomplete: Record<string, boolean>[] = [legacyChecks];
      for (const key of Object.keys(executionChecks)) {
        const missing: Record<string, boolean> = { ...complete };
        delete missing[key];
        incomplete.push(missing, { ...complete, [key]: false });
      }
      for (const checks of incomplete) {
        const { result, cleanup, output } = await test.run(checks);
        expect(result.status, result.stderr).toBe(1);
        expect(cleanup.publishedBeforeCleanup).toBe(false);
        await expect(NodeFSP.readFile(test.published)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          NodeFSP.readFile(NodePath.join(output, "workflow-models.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await test.close();
    }
  });

  it("publishes version 5 only after all execution checks and native deletion succeed", async () => {
    const test = await fixture();
    try {
      for (const options of [{ cleanupFails: true }, { tagChanged: true }]) {
        const { result, cleanup } = await test.run(
          { ...legacyChecks, ...executionChecks },
          options,
        );
        expect(result.status, result.stderr).toBe(1);
        expect(cleanup.publishedBeforeCleanup).toBe(false);
        await expect(NodeFSP.readFile(test.published)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const { result, cleanup } = await test.run({ ...legacyChecks, ...executionChecks });
      expect(result.status, result.stderr).toBe(0);
      expect(cleanup.publishedBeforeCleanup).toBe(false);
      expect(await test.readPublished()).toMatchObject({
        isolationVersion: 5,
        buildId: "fixture-build",
        templateRef: "fixture:build-00000000-0000-4000-8000-000000000001",
      });
      const published = await NodeFSP.readFile(test.published, "utf8");
      const modelOnly = await test.run({}, { isolation: false });
      expect(modelOnly.result.status, modelOnly.result.stderr).toBe(0);
      expect(await NodeFSP.readFile(test.published, "utf8")).toBe(published);
    } finally {
      await test.close();
    }
  });
});
