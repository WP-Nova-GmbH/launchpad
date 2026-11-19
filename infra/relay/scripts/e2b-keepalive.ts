// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Runs in the upstream E2B SDK container without an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodeTimersPromises from "node:timers/promises";
import { Sandbox, SandboxNotFoundError } from "e2b";

/** Infrastructure leases only: lifecycle decisions remain in the relay. */
export async function renewRunningAllocations(
  client: {
    list: (
      ...args: Parameters<typeof Sandbox.list>
    ) => Pick<ReturnType<typeof Sandbox.list>, "hasNext" | "nextItems">;
    setTimeout: typeof Sandbox.setTimeout;
    getInfo: typeof Sandbox.getInfo;
  },
  options: Parameters<typeof Sandbox.setTimeout>[2],
  timeoutMs: number,
) {
  const pages = client.list({
    ...options,
    query: { state: ["running"], metadata: { "launchpad.managed": "thread-vm-v1" } },
  });
  let renewed = 0;
  const failures: string[] = [];
  const limited: Array<{ sandboxId: string; expiresAt: string }> = [];
  while (pages.hasNext) {
    for (const vm of await pages.nextItems()) {
      // Recheck the server filter, and never use connect: it could wake a VM
      // paused by the relay between listing and renewing the lease.
      if (vm.state !== "running" || vm.metadata["launchpad.managed"] !== "thread-vm-v1") continue;
      try {
        const requestedEnd = Date.now() + timeoutMs;
        await client.setTimeout(vm.sandboxId, timeoutMs, options);
        // A 204 does not prove the requested lease was granted: E2B clamps it
        // to StartTime + MaxInstanceLength. Inspection must never wake the VM.
        const updated = await client.getInfo(vm.sandboxId, options);
        if (updated.state !== "running") continue;
        const actualEnd = updated.endAt.getTime();
        if (!Number.isFinite(actualEnd)) {
          failures.push(vm.sandboxId);
          continue;
        }
        // The API represents timeouts in seconds; allow timestamp rounding.
        if (actualEnd < requestedEnd - 1_000) {
          limited.push({ sandboxId: vm.sandboxId, expiresAt: updated.endAt.toISOString() });
          continue;
        }
        renewed++;
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) failures.push(vm.sandboxId);
      }
    }
  }
  return { renewed, failures, limited };
}

async function main() {
  const apiUrl = process.env.E2B_API_URL;
  if (!apiUrl || !["http:", "https:"].includes(new URL(apiUrl).protocol)) {
    throw new Error("An explicit self-hosted E2B_API_URL is required.");
  }
  const apiKey = (
    await NodeFSP.readFile(process.env.E2B_API_KEY_FILE ?? "/run/e2b/team-api-key", "utf8")
  ).trim();
  if (!apiKey) throw new Error("The E2B management key is empty.");
  const options = { apiUrl, apiKey, requestTimeoutMs: 10_000 };
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  let reportedLimits = new Set<string>();
  while (!stop.signal.aborted) {
    try {
      const result = await renewRunningAllocations(Sandbox, options, 15 * 60_000);
      if (result.failures.length) console.error("VM lease renewal failed", result.failures);
      for (const vm of result.limited) {
        if (!reportedLimits.has(vm.sandboxId))
          console.error("E2B maximum lifetime prevents full VM lease renewal", vm);
      }
      reportedLimits = new Set(result.limited.map((vm) => vm.sandboxId));
    } catch {
      // SDK errors can contain transport details; never log management keys.
      console.error("E2B lease reconciliation failed; running VMs may expire if this persists.");
    }
    await NodeTimersPromises.setTimeout(30_000, undefined, { signal: stop.signal }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href)
  await main();
