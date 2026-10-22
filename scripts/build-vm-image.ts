// @effect-diagnostics nodeBuiltinImport:off - Standalone development image builder.
// @effect-diagnostics globalConsole:off - CLI build progress and errors.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { ensureDevVmImage } from "./lib/dev-vm-image.ts";
import { buildLinuxVmArchive } from "./lib/vm-linux-archive.ts";
import { withVmBuildMemory } from "./lib/vm-build-memory.ts";

const defaultRoot = NodePath.resolve(import.meta.dirname, "..");

export function loadVmRelayEnv(repoRoot = defaultRoot): NodeJS.ProcessEnv {
  const file = NodePath.join(repoRoot, "infra/relay/.env");
  return {
    ...(NodeFS.existsSync(file) ? NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8")) : {}),
    ...process.env,
  };
}

/** Package the current checkout only when a new image is needed; builds never start the apps. */
export async function prepareVmRunnerImage(input: {
  env: NodeJS.ProcessEnv;
  repoRoot?: string;
  rebuild?: boolean;
}) {
  const repoRoot = input.repoRoot ?? defaultRoot;
  if (!input.env.E2B_API_KEY?.trim() || /[<>]/u.test(input.env.E2B_API_KEY))
    throw new Error("Set E2B_API_KEY in infra/relay/.env before building the VM runner image.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await ensureDevVmImage({
      repoRoot,
      env: input.env,
      ...(input.rebuild === undefined ? {} : { rebuild: input.rebuild }),
      buildArchive: async (outputDirectory) => {
        console.log(
          "[dev:vm] Building the Linux server and runner image. The first build can take several minutes…",
        );
        return buildLinuxVmArchive({
          repoRoot,
          outputDirectory,
          env: input.env,
          signal: controller.signal,
        });
      },
      buildTemplate: async ({ archive, sha256 }) => {
        const selectionPath =
          input.env.E2B_TEMPLATE_FILE?.trim() ||
          NodePath.join(repoRoot, "infra/relay/.t3/e2b-template.json");
        await NodeFSP.mkdir(NodePath.dirname(selectionPath), { recursive: true, mode: 0o700 });
        const staging = await NodeFSP.mkdtemp(
          NodePath.join(NodePath.dirname(selectionPath), ".e2b-template-"),
        );
        const stagedSelection = NodePath.join(staging, "selected.json");
        try {
          await withVmBuildMemory(
            { env: input.env, signal: controller.signal },
            () =>
              new Promise<void>((resolve, reject) => {
                controller.signal.throwIfAborted();
                const child = NodeChildProcess.spawn(
                  process.execPath,
                  [
                    "infra/relay/scripts/e2b-build-template.mjs",
                    "--server-archive",
                    archive,
                    "--server-sha256",
                    sha256,
                  ],
                  {
                    cwd: repoRoot,
                    env: { ...input.env, E2B_TEMPLATE_FILE: stagedSelection },
                    stdio: "inherit",
                    signal: controller.signal,
                  },
                );
                let failure: Error | undefined;
                child.once("error", (error) => {
                  failure = error;
                });
                child.once("close", (code, signal) => {
                  if (failure) reject(failure);
                  else if (code !== 0)
                    reject(
                      new Error(
                        `VM runner image build exited (${code ?? signal}). The previous image selection was preserved.`,
                      ),
                    );
                  else resolve();
                });
              }),
          );
          // Publish only after the build's temporary host reservation was restored.
          await NodeFSP.rename(stagedSelection, selectionPath);
        } finally {
          await NodeFSP.rm(staging, { recursive: true, force: true });
        }
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  NodeUtil.parseArgs({ options: {} });
  prepareVmRunnerImage({ env: loadVmRelayEnv(), rebuild: true })
    .then(() => console.log("Built and selected the VM runner image. Restart dev:vm to use it."))
    .catch((error: unknown) => {
      console.error(`[dev:vm] ${error instanceof Error ? error.message : "Image build failed."}`);
      process.exitCode = 1;
    });
}
