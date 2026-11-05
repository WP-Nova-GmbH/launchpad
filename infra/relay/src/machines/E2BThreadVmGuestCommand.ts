import type { CommandHandle } from "e2b";

/** A disconnected SDK stream leaves a background command running. Callers use
 * flock --no-fork so this captured PID owns both the process and its lock. */
export async function sendThreadVmCommandInput(
  command: Pick<CommandHandle, "sendStdin" | "wait" | "kill" | "exitCode">,
  payload: string,
) {
  try {
    await command.sendStdin(payload + "\n");
    return await command.wait();
  } catch (error) {
    if (command.exitCode === undefined) await command.kill().catch(() => false);
    throw error;
  }
}
