import * as NodeCrypto from "node:crypto";
import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { make, recordProviderTaskLiveness } from "../orchestration/ThreadBackgroundLiveness.ts";
import type { VmHarnessIdentity } from "../vmWorkload.ts";

const workflowVmBackgroundReceiptFile = "workflow-vm-background.json";
const Receipt = Schema.fromJsonString(
  Schema.Struct({
    bootId: Schema.String,
    groupId: Schema.String,
    coordinatorPid: Schema.Int,
    coordinatorStartTicks: Schema.String,
    busy: Schema.Boolean,
    revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  }),
);
const decodeReceipt = Schema.decodeUnknownOption(Receipt);
const encodeReceipt = Schema.encodeSync(Receipt);
const readCoordinatorStartTicks = (fs: FileSystem.FileSystem) =>
  fs.readFileString("/proc/self/stat").pipe(
    Effect.map((stat) => stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]),
    Effect.orElseSucceed(() => undefined),
  );

export const readWorkflowVmBackgroundRevision = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stateDir: string,
  inventory: {
    readonly bootId: string;
    readonly groups: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
  },
) {
  const file = yield* fs
    .readFileString(path.join(stateDir, workflowVmBackgroundReceiptFile))
    .pipe(Effect.option);
  const receipt = Option.flatMap(file, decodeReceipt);
  if (Option.isNone(receipt) || receipt.value.bootId !== inventory.bootId) return undefined;
  const { value } = receipt;
  if (
    inventory.groups.length === 0 ||
    (inventory.groups.length === 1 && inventory.groups[0]?.kind === "terminal")
  )
    return value.busy ? `${value.revision}:stopped` : value.revision;
  if (
    inventory.groups.length !== 1 ||
    inventory.groups[0]?.kind !== "provider" ||
    inventory.groups[0].id !== value.groupId ||
    value.busy ||
    value.coordinatorPid !== process.pid ||
    value.coordinatorStartTicks !== (yield* readCoordinatorStartTicks(fs))
  )
    return undefined;
  return value.revision;
});

/** The guest inspector reads this alongside SQLite without contacting the coordinator. */
export const makeWorkflowVmBackgroundActivity = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stateDir: string,
  threadId: ThreadId,
) {
  const file = path.join(stateDir, workflowVmBackgroundReceiptFile);
  const lock = yield* Semaphore.make(1);
  const tasks = make();
  let harness: VmHarnessIdentity | undefined;
  let childActive = false;
  let reported: boolean | undefined;
  let currentRevision: string | undefined;
  const coordinatorStartTicks = yield* readCoordinatorStartTicks(fs);
  const isBusy = () => childActive || tasks.getThreadBackgroundLiveness(threadId) !== null;

  const publish = Effect.gen(function* () {
    if (!harness || !coordinatorStartTicks) return;
    const busy = isBusy();
    if (busy === reported && currentRevision) return;
    currentRevision = undefined;
    const revision = NodeCrypto.randomUUID().replaceAll("-", "");
    const temporary = `${file}.${revision}`;
    const receipt = {
      bootId: harness.bootId,
      groupId: harness.groupId,
      coordinatorPid: process.pid,
      coordinatorStartTicks,
      busy,
      revision,
    };
    yield* fs.remove(file, { force: true });
    yield* fs
      .writeFileString(temporary, encodeReceipt(receipt), { mode: 0o600 })
      .pipe(
        Effect.andThen(fs.rename(temporary, file)),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
    reported = busy;
    currentRevision = revision;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not publish workflow VM background activity", { cause }),
    ),
  );

  return {
    observeChildren: (busy: boolean, identity: VmHarnessIdentity) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          if (harness?.groupId !== identity.groupId) reported = undefined;
          harness = identity;
          childActive = busy;
        }).pipe(Effect.andThen(publish)),
      ),
    observeTask: (event: ProviderRuntimeEvent) =>
      lock.withPermits(1)(
        Effect.sync(() => recordProviderTaskLiveness(tasks, event)).pipe(Effect.andThen(publish)),
      ),
    getQuietRevision: () => (isBusy() ? undefined : currentRevision),
  };
});
