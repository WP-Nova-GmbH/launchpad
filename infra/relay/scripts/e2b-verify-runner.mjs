import { Template, TemplateError } from "e2b";
import * as NodeFSP from "node:fs/promises";
import {
  verifiedWorkflowVmModelProof,
  WORKFLOW_VM_ISOLATION_VERSION,
} from "../src/threads/ThreadVmWorkflowModelProof.ts";

// Exit 2 only for a verified absence. A failed request must leave deployment state intact.
const [templateRef, buildId, proofPath] = process.argv.slice(2);
const runner = /^([a-zA-Z0-9][a-zA-Z0-9_-]*):(build-[a-f0-9-]+)$/u.exec(templateRef ?? "");
const { E2B_API_URL, E2B_API_KEY_FILE } = process.env;
const apiUrl = URL.parse(E2B_API_URL ?? "");
if (
  process.argv.length < 4 ||
  process.argv.length > 5 ||
  !runner ||
  !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(buildId ?? "") ||
  !apiUrl ||
  !["http:", "https:"].includes(apiUrl.protocol) ||
  apiUrl.username ||
  apiUrl.password ||
  apiUrl.search ||
  apiUrl.hash ||
  !E2B_API_KEY_FILE
) {
  console.error("Provide the runner template ref, build ID, E2B_API_URL and E2B_API_KEY_FILE.");
  process.exitCode = 1;
} else {
  try {
    const apiKey = (await NodeFSP.readFile(E2B_API_KEY_FILE, "utf8")).trim();
    if (!apiKey) throw new Error("Missing E2B API key");
    const [, templateId, tag] = runner;
    const tags = await Template.getTags(templateId, {
      apiUrl: apiUrl.href.replace(/\/$/u, ""),
      apiKey,
      requestTimeoutMs: 30_000,
      retries: 0,
    });
    if (
      tags.some(
        ({ tag, buildId }) =>
          typeof tag !== "string" || typeof buildId !== "string" || !tag || !buildId,
      )
    )
      throw new Error("Malformed E2B template tags");
    if (!tags.some((entry) => entry.tag === tag && entry.buildId === buildId)) {
      process.exitCode = 2;
    } else if (proofPath !== undefined) {
      const content = await NodeFSP.readFile(proofPath, "utf8").catch(() => "");
      const proof = verifiedWorkflowVmModelProof(content, templateRef, buildId);
      if (proof?.isolationVersion !== WORKFLOW_VM_ISOLATION_VERSION) {
        process.exitCode = 3;
      } else {
        process.stdout.write(JSON.stringify(proof) + "\n");
      }
    }
  } catch (error) {
    if (error instanceof TemplateError && error.statusCode === 404) {
      process.exitCode = 2;
    } else {
      // SDK errors can contain request credentials.
      console.error("Could not verify the runner template with E2B.");
      process.exitCode = 1;
    }
  }
}
