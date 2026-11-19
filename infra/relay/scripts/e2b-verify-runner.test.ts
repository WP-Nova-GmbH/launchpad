// @effect-diagnostics nodeBuiltinImport:off - Exercises the standalone CLI with an offline SDK.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import {
  WORKFLOW_VM_ISOLATION_VERSION,
  WORKFLOW_VM_MODEL_PROOF_VERSION,
} from "../src/threads/ThreadVmWorkflowModelProof.ts";

const tag = "build-00000000-0000-4000-8000-000000000001";
const buildId = "fixture-build";
const templateRef = `fixture-template:${tag}`;
const key = "offline-fixture-key";
const apiUrl = "http://127.0.0.1:3000";
const modelProof = {
  schemaVersion: WORKFLOW_VM_MODEL_PROOF_VERSION,
  templateRef,
  buildId,
  catalog: {
    defaultModel: "gpt-6.1-sol",
    models: [
      {
        slug: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
  },
  isolationVersion: WORKFLOW_VM_ISOLATION_VERSION,
};
const sdk = `data:text/javascript,${encodeURIComponent(`
  import { equal } from 'node:assert/strict';
  export class TemplateError extends Error {}
  export class Template {
    static async getTags(templateId, { apiKey, apiUrl }) {
      equal(templateId, 'fixture-template');
      equal(apiKey, ${JSON.stringify(key)});
      equal(apiUrl, ${JSON.stringify(apiUrl)});
      switch (process.env.VERIFY_FIXTURE) {
        case "exact": return [{ tag: ${JSON.stringify(tag)}, buildId: ${JSON.stringify(buildId)} }];
        case "moved": return [{ tag: ${JSON.stringify(tag)}, buildId: "new-build" }];
        case "missing-tag": return [];
        case "malformed": return [{ tag: ${JSON.stringify(tag)} }];
        case "missing-template":
          throw Object.assign(new TemplateError("not found"), { statusCode: 404 });
        case "unavailable":
          throw Object.assign(new TemplateError(apiKey), { statusCode: 503 });
        default: throw new Error("Unexpected SDK call");
      }
    }
  }
`)}`;
const hooks = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from 'node:module';
  registerHooks({ resolve(specifier, context, next) {
    return specifier === 'e2b' ? { url: ${JSON.stringify(sdk)}, shortCircuit: true }
      : next(specifier, context);
  } });
`)}`;

it.each([
  { scenario: "exact", status: 0 },
  { scenario: "moved", status: 2 },
  { scenario: "missing-tag", status: 2 },
  { scenario: "missing-template", status: 2 },
  { scenario: "unavailable", status: 1 },
  { scenario: "malformed", status: 1 },
  { scenario: "unsafe-url", status: 1 },
  { scenario: "exact", proof: "valid", status: 0 },
  { scenario: "exact", proof: "missing", status: 3 },
  { scenario: "exact", proof: "malformed", status: 3 },
  { scenario: "exact", proof: "wrong-build", status: 3 },
  { scenario: "exact", proof: "stale-isolation", status: 3 },
  { scenario: "moved", proof: "missing", status: 2 },
  { scenario: "unavailable", proof: "valid", status: 1 },
])(
  "returns $status for E2B runner $scenario and proof $proof",
  async ({ scenario, proof, status }) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "verify-runner-"));
    try {
      const keyPath = NodePath.join(directory, "key");
      await NodeFSP.writeFile(keyPath, `${key}\n`, { mode: 0o600 });
      const runner = NodeURL.fileURLToPath(new URL("./e2b-verify-runner.mjs", import.meta.url));
      const proofPath = NodePath.join(directory, "proof.json");
      if (proof && proof !== "missing") {
        const fixture = {
          ...modelProof,
          ...(proof === "wrong-build" ? { buildId: "different-build" } : {}),
          ...(proof === "stale-isolation"
            ? { isolationVersion: WORKFLOW_VM_ISOLATION_VERSION - 1 }
            : {}),
        };
        await NodeFSP.writeFile(
          proofPath,
          proof === "malformed" ? "{invalid" : JSON.stringify(fixture, null, 2),
        );
      }
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        ["--import", hooks, runner, templateRef, buildId, ...(proof ? [proofPath] : [])],
        {
          env: {
            E2B_API_KEY_FILE: keyPath,
            E2B_API_URL: scenario === "unsafe-url" ? `http://${key}@example.test` : apiUrl,
            VERIFY_FIXTURE: scenario,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(result.status).toBe(status);
      expect(result.stdout).toBe(status === 0 && proof ? JSON.stringify(modelProof) + "\n" : "");
      expect(result.stderr).not.toContain(key);
      if (status === 1) {
        expect(result.stderr).toContain(
          scenario === "unsafe-url" ? "Provide the runner template ref" : "Could not verify",
        );
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
