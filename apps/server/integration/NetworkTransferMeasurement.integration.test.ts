import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { rpcChunksFromMessage, transferDelta } from "./NetworkTransferMeasurement.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  transferBudgetViolations,
  type TransferBudgetRun,
} from "./TransferBudgetReport.integration.ts";

it("separates RPC chunks from transport messages and counts duplicate cursors within each phase", () => {
  const before = rpcChunksFromMessage(
    Buffer.from(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "thread",
        values: [{ kind: "event", event: { sequence: 8 } }],
      }),
    ),
  );
  const measured = rpcChunksFromMessage(
    Buffer.from(
      JSON.stringify([
        { _tag: "Exit", requestId: "dispatch", exit: { _tag: "Success", value: {} } },
        {
          _tag: "Chunk",
          requestId: "thread",
          values: [
            { kind: "event", event: { sequence: 8 } },
            { kind: "event", event: { sequence: 9 } },
          ],
        },
        {
          _tag: "Chunk",
          requestId: "thread",
          values: [{ kind: "event", event: { sequence: 9 } }, { kind: "synchronized" }],
        },
      ]),
    ),
  );
  assert.deepEqual(measured, [
    { items: 2, detailEventSequences: [8, 9] },
    { items: 2, detailEventSequences: [9] },
  ]);
  const start = { wireBytes: 10, decodedBytes: 20, messages: 1, rpcChunks: before };
  const end = {
    wireBytes: 110,
    decodedBytes: 220,
    messages: 2,
    rpcChunks: [...before, ...measured],
  };
  const delta = transferDelta(start, end);
  assert.deepEqual(delta, { wireBytes: 100, decodedBytes: 200, messages: 1, rpcChunks: measured });
  assert.deepEqual(transferDelta({ wireBytes: 0, decodedBytes: 0, messages: 0 }, delta), {
    wireBytes: 100,
    decodedBytes: 200,
    messages: 1,
  });

  const snapshot = {
    status: 200,
    contentEncoding: "gzip",
    encodedBody: new Uint8Array(),
    encodedBodyBytes: 0,
    decodedBody: new Uint8Array(),
    decodedBodyBytes: 0,
    wireBytes: 100,
  };
  const run = {
    provider: ProviderDriverKind.make("codex"),
    threadSnapshot: snapshot,
    measuredTurnWebSocket: delta,
    shellSnapshot: snapshot,
    measuredTurnShellWebSocket: delta,
    measuredTurnSecondClientWebSocket: delta,
    reconnectThread: { ...delta, mode: "replay" },
    reconnectShell: { ...delta, mode: "replay" },
    measuredTurnSqlStatements: 100,
    reconnectSqlStatements: 10,
  } satisfies TransferBudgetRun;
  const report = formatTransferBudgetReport([run]);
  assert.include(
    report,
    "1 WebSocket messages; 2 RPC chunks; 3 detail events; 2 unique sequences; 1 duplicates. Chunk sizes (items × chunks): 2 × 2.",
  );
  assert.deepEqual(transferBudgetViolations([run]), []);
  assert.deepEqual(
    transferBudgetViolations([{ ...run, measuredTurnWebSocket: { ...delta, messages: 22 } }]),
    ["codex: measured-turn WebSocket messages was 22, maximum 21"],
  );
  assert.equal(
    formatTransferBudgetResult([run]),
    formatTransferBudgetResult([
      { ...run, measuredTurnWebSocket: { wireBytes: 100, decodedBytes: 200, messages: 1 } },
    ]),
  );
});
