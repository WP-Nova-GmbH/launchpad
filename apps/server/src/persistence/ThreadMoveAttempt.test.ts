import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadMoveAttemptJournal } from "./ThreadMoveAttempt.ts";
import migration from "./Migrations/087_ThreadMoveAttempts.ts";
import { makeThreadMoveProgress } from "../relay/ThreadMoveProgress.ts";

const owner = {
  operationId: "move",
  threadId: "thread",
  environmentId: "vm",
  generation: 2,
  relayUrl: "https://relay.example",
};
const move = { operationId: owner.operationId, threadId: owner.threadId };
const wait = {
  stage: "downloading" as const,
  completedBytes: 0,
  totalBytes: null,
  completedArtifacts: 0,
  totalArtifacts: null,
  waitingForAuth: "account_selection" as const,
};

it.effect(
  "does not reuse an unobserved attempt or wait revision after reopening the database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "move-attempt-" });
      const filename = `${root}/state.sqlite`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* migration;
          const journal = makeThreadMoveAttemptJournal(yield* SqlClient.SqlClient);
          const attempt = yield* journal.begin(owner, move);
          expect(attempt.attempt).toBe(1);
          expect(yield* attempt.save(wait)).toMatchObject({ attempt: 1, revision: 1 });
          // The outbound request may still reach the relay after this process exits.
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const journal = makeThreadMoveAttemptJournal(yield* SqlClient.SqlClient);
          const resumed = yield* journal.begin(owner, move, { resumeWaiting: true });
          expect(resumed.attempt).toBe(1);
          expect(resumed.acknowledgedRevision).toBe(0);
          expect(
            yield* resumed.save({ ...wait, waitingForAuth: "personal_sign_in" }),
          ).toMatchObject({
            attempt: 1,
            revision: 2,
          });
          const work = yield* journal.begin(owner, move);
          expect(work.attempt).toBe(2);
          expect(yield* Effect.flip(resumed.save(wait))).toMatchObject({
            _tag: "ThreadMoveAttemptError",
          });
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "seeds retries from participant failures and tombstones without borrowing another side",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const journal = makeThreadMoveAttemptJournal(yield* SqlClient.SqlClient);
      const remote = {
        ...move,
        participantStates: [
          { environmentId: "source", generation: 1, resolvedBeforeAttempt: 90, failure: null },
          {
            environmentId: owner.environmentId,
            generation: owner.generation,
            resolvedBeforeAttempt: 8,
            failure: { attempt: 9, detail: "Old failure", reportedAt: "2026-10-30T00:00:00.000Z" },
          },
        ],
      };
      const current = yield* journal.begin(owner, remote);
      expect(current.attempt).toBe(10);
      yield* current.save(wait);
      yield* current.end;
      expect((yield* journal.begin(owner, remote, { resumeWaiting: true })).attempt).toBe(11);
      for (const identity of [
        { ...owner, threadId: "other" },
        { ...owner, relayUrl: "https://other.example" },
      ])
        expect(yield* Effect.flip(journal.begin(identity, move))).toMatchObject({
          _tag: "ThreadMoveAttemptError",
        });
      expect((yield* journal.begin({ ...owner, generation: 3 }, move)).attempt).toBe(1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("uses the durable attempt before a best-effort progress request can be lost", () =>
  Effect.gen(function* () {
    yield* migration;
    const sql = yield* SqlClient.SqlClient;
    const journal = makeThreadMoveAttemptJournal(sql);
    const first = yield* journal.begin(owner, move);
    const sent: number[] = [];
    const lost = makeThreadMoveProgress(
      [],
      owner.environmentId,
      (report) =>
        Effect.sync(() => sent.push(report.attempt)).pipe(Effect.andThen(Effect.fail("lost"))),
      first,
    );
    yield* lost.stage("downloading");
    const second = yield* makeThreadMoveAttemptJournal(sql).begin(owner, move);
    const retry = makeThreadMoveProgress(
      [],
      owner.environmentId,
      (report) => Effect.sync(() => sent.push(report.attempt)),
      second,
    );
    yield* retry.stage("downloading");
    expect(sent).toEqual([1, 2]);
    expect(
      yield* sql`SELECT attempt,revision,acknowledged_revision FROM thread_move_attempts`,
    ).toEqual([{ attempt: 2, revision: 1, acknowledged_revision: 1 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "retries lost wait reports across restart without attempt churn or duplicate acknowledged waits",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const sql = yield* SqlClient.SqlClient;
      const journal = makeThreadMoveAttemptJournal(sql);
      const first = yield* journal.begin(owner, move);
      const sent: Array<{ attempt: number; revision: number; waitingForAuth?: unknown }> = [];
      yield* makeThreadMoveProgress(
        [],
        owner.environmentId,
        (report) => Effect.sync(() => sent.push(report)).pipe(Effect.andThen(Effect.fail("lost"))),
        first,
      ).waitForAuth("account_selection");
      const resumed = yield* makeThreadMoveAttemptJournal(sql).begin(owner, move, {
        resumeWaiting: true,
      });
      const progress = makeThreadMoveProgress(
        [],
        owner.environmentId,
        (report) => Effect.sync(() => sent.push(report)),
        resumed,
      );
      yield* progress.waitForAuth("account_selection");
      yield* progress.waitForAuth("account_selection");
      yield* progress.waitForAuth("personal_sign_in");
      expect(sent).toMatchObject([
        { attempt: 1, revision: 1, stage: "downloading", waitingForAuth: "account_selection" },
        { attempt: 1, revision: 2, waitingForAuth: "account_selection" },
        { attempt: 1, revision: 3, waitingForAuth: "personal_sign_in" },
      ]);
      const work = yield* journal.begin(owner, move);
      yield* makeThreadMoveProgress(
        [],
        owner.environmentId,
        (report) => Effect.sync(() => sent.push(report)),
        work,
      ).stage("downloading");
      expect(sent.at(-1)).toMatchObject({ attempt: 2, revision: 1, waitingForAuth: null });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
