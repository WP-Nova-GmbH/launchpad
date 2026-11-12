import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu));
const Ordinal = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const HistoryPosition = Schema.Struct({
  thread_id: Id,
  end_ordinal_exclusive: Ordinal,
  end_byte_offset: Ordinal,
});
const Metadata = Schema.Struct({
  id: Id,
  session_id: Id,
  cli_version: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  history_mode: Schema.Literal("paginated"),
  parent_thread_id: Schema.optionalKey(Schema.NullOr(Id)),
  forked_from_id: Schema.optionalKey(Schema.NullOr(Id)),
  agent_path: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  subagent_history_start_ordinal: Schema.optionalKey(Ordinal),
  history_base: Schema.optionalKey(Schema.NullOr(HistoryPosition)),
});
const Record = Schema.Struct({
  ordinal: Ordinal,
  type: Schema.NonEmptyString,
  payload: Schema.Unknown,
});
const ObjectRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Record));
const decodeObjectRecord = Schema.decodeUnknownSync(Schema.fromJsonString(ObjectRecord));
const decodeObject = Schema.decodeUnknownSync(ObjectRecord);
const decodeMetadata = Schema.decodeUnknownSync(Metadata);
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const FunctionCall = Schema.Struct({
  type: Schema.Literals(["function_call", "custom_tool_call"]),
  name: Schema.String,
  call_id: Schema.NonEmptyString,
});
const FunctionOutput = Schema.Struct({
  type: Schema.Literals(["function_call_output", "custom_tool_call_output"]),
  call_id: Schema.NonEmptyString,
  output: Schema.String,
});
const SpawnOutput = Schema.Struct({ task_name: Schema.NonEmptyString });
const LegacySpawn = Schema.is(Schema.Struct({ type: Schema.Literal("collab_agent_spawn_end") }));
const CollabItem = Schema.Struct({
  type: Schema.Literal("item_completed"),
  item: Schema.Struct({
    type: Schema.Literals(["collab_agent_tool_call", "collabAgentToolCall", "CollabAgentToolCall"]),
    tool: Schema.String,
  }),
});
const isCollabItem = Schema.is(CollabItem);
const isFunctionCall = Schema.is(FunctionCall);
const isFunctionOutput = Schema.is(FunctionOutput);
const decodeSpawnOutput = Schema.decodeUnknownSync(Schema.fromJsonString(SpawnOutput));
const filename =
  /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))?\.jsonl$/iu;

export class CodexNativeHistoryError extends Schema.TaggedError<CodexNativeHistoryError>()(
  "CodexNativeHistoryError",
  { message: Schema.String },
) {}
const fail = (message: string): never => {
  throw new CodexNativeHistoryError({ message });
};

/** Physical rollout IDs and stable conversation IDs differ after native revert. */
export const parseCodexNativeRollout = (name: string, text: string) => {
  const identity = filename.exec(name);
  if (!identity || !text.endsWith("\n") || Buffer.byteLength(text) > 64 * 1024 * 1024)
    return fail("Invalid or incomplete native rollout.");
  const lines = text.slice(0, -1).split("\n");
  const records = lines.map((line) => decodeRecord(line));
  const original = lines.map((line) => decodeObjectRecord(line));
  const first = records[0];
  if (!first || first.type !== "session_meta") return fail("Native session metadata is missing.");
  const metadata = decodeMetadata(first.payload);
  if (metadata.id !== identity[1])
    return fail("Native filename and conversation identity disagree.");
  const base = metadata.history_base;
  if (first.ordinal !== (base?.end_ordinal_exclusive ?? 0))
    return fail("Native history starts at an invalid ordinal.");
  const offsets = new Map<number, number>();
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const record = records[index]!;
    if (record.ordinal !== first.ordinal + index)
      return fail("Native history has a missing or duplicate record.");
    offset += Buffer.byteLength(line) + 1;
    offsets.set(record.ordinal + 1, offset);
  }
  return {
    name,
    text,
    metadata,
    rolloutId: identity[2] ?? identity[1]!,
    records,
    original,
    offsets,
  };
};
export type CodexNativeRollout = ReturnType<typeof parseCodexNativeRollout>;

const indexRollouts = (rollouts: ReadonlyArray<CodexNativeRollout>) => {
  if (
    !rollouts.length ||
    rollouts.length > 256 ||
    rollouts.reduce((bytes, r) => bytes + Buffer.byteLength(r.text), 0) > 256 * 1024 * 1024
  )
    return fail("Native history exceeds the transfer limit.");
  const byName = new Map(rollouts.map((r) => [r.name, r]));
  const byId = new Map(rollouts.map((r) => [r.rolloutId, r]));
  if (byName.size !== rollouts.length || byId.size !== rollouts.length)
    return fail("Native history contains duplicate physical identities.");
  return { byName, byId };
};
const canonicalAgentPath = (value: string) =>
  value.startsWith("/root/") &&
  value.length <= 4096 &&
  !/[\0\r\n]/u.test(value) &&
  value
    .split("/")
    .slice(2)
    .every((part) => part !== "" && part !== "." && part !== "..") &&
  !value.endsWith("/");

/** A successful native spawn receipt identifies the canonical child path. Native
 * arguments can be opaque; matching arbitrary UUIDs or copying a provider home
 * would neither prove completeness nor scope the transfer to this conversation. */
const childTasks = (records: ReadonlyArray<CodexNativeRollout["records"][number]>) => {
  const calls = new Set<string>();
  const outputs = new Map<string, string>();
  for (const record of records) {
    if (
      record.type === "event_msg" &&
      (LegacySpawn(record.payload) ||
        (isCollabItem(record.payload) && /spawn/iu.test(record.payload.item.tool)))
    )
      return fail("This native child creation format has not been verified for transfer.");
    if (record.type !== "response_item") continue;
    if (isFunctionCall(record.payload)) {
      if (/^(?:functions\.)?spawn_agents_on_csv$/u.test(record.payload.name))
        return fail("Bulk native child creation has not been verified for transfer.");
      if (/^(?:functions\.)?spawn_agent$/u.test(record.payload.name)) {
        if (calls.has(record.payload.call_id)) return fail("Duplicate native spawn identity.");
        calls.add(record.payload.call_id);
      }
    }
    if (isFunctionOutput(record.payload)) {
      if (outputs.has(record.payload.call_id)) return fail("Duplicate native tool receipt.");
      outputs.set(record.payload.call_id, record.payload.output);
    }
  }
  return [...calls].map((id) => {
    const output = outputs.get(id);
    if (output === undefined) return fail("A native child creation has no settled receipt.");
    const task = decodeSpawnOutput(output).task_name;
    if (!canonicalAgentPath(task)) return fail("Invalid native child path.");
    return task;
  });
};

/** Select only the root's reachable children and immutable history prefixes.
 * The caller supplies the current root path reported by Codex after draining it.
 * Ambiguous child heads block transfer instead of guessing an older history. */
export const selectCodexNativeHistory = (
  rootName: string,
  rollouts: ReadonlyArray<CodexNativeRollout>,
) => {
  const { byName, byId } = indexRollouts(rollouts);
  const root = byName.get(rootName);
  if (!root || root.metadata.parent_thread_id || root.metadata.session_id !== root.metadata.id)
    return fail("The selected native root is not an independent conversation.");
  const rootId = root.metadata.id;
  const extents = new Map<string, number>();
  const heads = new Map<string, string>();
  const agentHeads = new Map<string, string>();
  const visiting = new Set<string>();
  const logicalRecords = (
    rollout: CodexNativeRollout,
    endByte = Buffer.byteLength(rollout.text),
  ): CodexNativeRollout["records"] => {
    if (visiting.has(rollout.name)) return fail("Native history contains a prefix cycle.");
    if (rollout.metadata.session_id !== rootId)
      return fail("Native history escapes this conversation.");
    visiting.add(rollout.name);
    extents.set(rollout.name, Math.max(extents.get(rollout.name) ?? 0, endByte));
    const base = rollout.metadata.history_base;
    let inherited: CodexNativeRollout["records"] = [];
    if (base) {
      const prefix = byId.get(base.thread_id);
      if (
        !prefix ||
        base.end_byte_offset <= 0 ||
        prefix.offsets.get(base.end_ordinal_exclusive) !== base.end_byte_offset
      )
        return fail("A native history prefix is missing or has an invalid byte boundary.");
      inherited = logicalRecords(prefix, base.end_byte_offset);
    }
    const selected = rollout.records.filter(
      (r) => (rollout.offsets.get(r.ordinal + 1) ?? Infinity) <= endByte,
    );
    visiting.delete(rollout.name);
    return [...inherited, ...selected];
  };
  const addHead = (head: CodexNativeRollout, agentPath: string) => {
    if (heads.has(head.metadata.id) || agentHeads.has(agentPath))
      return fail("Native child ownership is ambiguous.");
    heads.set(head.metadata.id, head.name);
    agentHeads.set(agentPath, head.metadata.id);
    const own = logicalRecords(head).filter(
      (r) => r.ordinal >= (head.metadata.subagent_history_start_ordinal ?? 0),
    );
    for (const task of new Set(childTasks(own))) {
      if (task.slice(0, task.lastIndexOf("/")) !== agentPath)
        return fail("A native spawn receipt names a child of another agent.");
      const candidates = rollouts.filter(
        (r) => r.metadata.agent_path === task && r.metadata.session_id === rootId,
      );
      const ids = new Set(candidates.map((r) => r.metadata.id));
      if (ids.size !== 1) return fail("A required native child is missing or ambiguous.");
      const ancestors = new Set(candidates.map((r) => r.metadata.history_base?.thread_id));
      const leaves = candidates.filter((r) => !ancestors.has(r.rolloutId));
      if (leaves.length !== 1) return fail("A required native child has ambiguous history heads.");
      const child = leaves[0]!;
      if (
        child.metadata.parent_thread_id !== head.metadata.id ||
        child.metadata.forked_from_id !== head.metadata.id ||
        child.metadata.subagent_history_start_ordinal === undefined
      )
        return fail("The native child does not belong to its declared parent.");
      addHead(child, task);
    }
  };
  addHead(root, "/root");
  return {
    rootId,
    heads,
    rollouts: [...extents].map(([name, bytes]) => {
      const original = byName.get(name)!;
      const text = Buffer.from(original.text).subarray(0, bytes).toString("utf8");
      return parseCodexNativeRollout(name, text);
    }),
  };
};

/** Relocating an image/audio path changes JSONL byte lengths. Repair prefix byte
 * offsets in dependency order while keeping exclusive ordinals and all IDs. */
export const repairCodexNativeHistoryOffsets = (rollouts: ReadonlyArray<CodexNativeRollout>) => {
  const { byId } = indexRollouts(rollouts);
  const completed = new Map<string, CodexNativeRollout>();
  const visiting = new Set<string>();
  const repair = (rollout: CodexNativeRollout): CodexNativeRollout => {
    const prior = completed.get(rollout.name);
    if (prior) return prior;
    if (visiting.has(rollout.name)) return fail("Native history contains a prefix cycle.");
    visiting.add(rollout.name);
    let result = rollout;
    const base = rollout.metadata.history_base;
    if (base) {
      const source = byId.get(base.thread_id);
      if (!source) return fail("A required native prefix is missing.");
      const prefix = repair(source);
      const offset = prefix.offsets.get(base.end_ordinal_exclusive);
      if (offset === undefined) return fail("A required native prefix is incomplete.");
      if (offset !== base.end_byte_offset) {
        const first = rollout.original[0]!;
        const payload = decodeObject(first.payload);
        const metadata = encodeRecord({
          ...first,
          payload: { ...payload, history_base: { ...base, end_byte_offset: offset } },
        });
        result = parseCodexNativeRollout(
          rollout.name,
          metadata + "\n" + rollout.text.slice(rollout.text.indexOf("\n") + 1),
        );
      }
    }
    visiting.delete(rollout.name);
    completed.set(rollout.name, result);
    return result;
  };
  return rollouts.map(repair);
};
