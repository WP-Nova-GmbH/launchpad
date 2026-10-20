import { describe, expect, it } from "vite-plus/test";
import { sendThreadVmCommandInput } from "./E2BThreadVmGuestCommand.ts";

describe("VM command stream loss", () => {
  it("stops the running lock owner and preserves the original failure", async () => {
    const lost = new Error("stream disconnected");
    let running = true;
    const command = {
      exitCode: undefined,
      sendStdin: async () => {},
      wait: async () => {
        throw lost;
      },
      kill: async () => {
        running = false;
        return true;
      },
    };
    await expect(sendThreadVmCommandInput(command, "public fixture")).rejects.toBe(lost);
    expect(running).toBe(false);
  });
  it("does not kill a command whose failed exit is already known", async () => {
    const exited = new Error("exit status 1");
    let killed = false;
    const command = {
      exitCode: 1,
      sendStdin: async () => {},
      wait: async () => {
        throw exited;
      },
      kill: async () => {
        killed = true;
        return false;
      },
    };
    await expect(sendThreadVmCommandInput(command, "public fixture")).rejects.toBe(exited);
    expect(killed).toBe(false);
  });
  it("retains the original error when stopping an unconfirmed command also fails", async () => {
    const lost = new Error("stdin disconnected");
    const command = {
      exitCode: undefined,
      sendStdin: async () => {
        throw lost;
      },
      wait: async () => {
        throw new Error("wait must not run");
      },
      kill: async () => {
        throw new Error("stop reply lost");
      },
    };
    await expect(sendThreadVmCommandInput(command, "public fixture")).rejects.toBe(lost);
  });
});
