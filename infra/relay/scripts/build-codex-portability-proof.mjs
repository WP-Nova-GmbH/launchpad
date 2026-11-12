import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite";

const output = process.argv[2];
if (!output || !NodePath.isAbsolute(output) || process.argv.length !== 3) {
  throw new Error("Usage: node build-codex-portability-proof.mjs /absolute/new-output-directory");
}
// Do not let a bundler's output cleanup remove existing operator files.
await NodeFSP.mkdir(output, { mode: 0o700 });
for (const name of [
  "codex-portability-proof.mjs",
  "e2b-codex-portability-smoke.mjs",
  "run-codex-portability-proof.mjs",
  "workspace-portability-proof.mjs",
  "e2b-workspace-portability-smoke.mjs",
])
  await build({
    configFile: false,
    root: NodeURL.fileURLToPath(new URL("../../../", import.meta.url)),
    logLevel: "warn",
    build: {
      ssr: NodeURL.fileURLToPath(new URL(name, import.meta.url)),
      target: "node24",
      outDir: output,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        output: { entryFileNames: name, codeSplitting: false },
      },
    },
    ssr: { noExternal: true },
  });
