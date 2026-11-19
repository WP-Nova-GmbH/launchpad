// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type * as NodeChildProcess from "node:child_process";

export class FakeClaudeChild extends NodeEvents.EventEmitter {
  readonly pid = 987654321;
  readonly stdin = new NodeStream.PassThrough();
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals> = [];
  kill(signal: NodeJS.Signals) {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
  }
  asNativeChild() {
    return this as unknown as NodeChildProcess.ChildProcessWithoutNullStreams;
  }
}
