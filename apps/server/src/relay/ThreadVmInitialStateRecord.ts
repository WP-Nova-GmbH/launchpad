import { RelayThreadVmSetupInput, RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const State = Schema.Struct({
  input: RelayThreadVmSetupInput,
  workspaceRoot: Schema.NonEmptyString,
  receipt: Schema.NullOr(RelayThreadVmSetupReceipt),
});
export const encodeThreadVmInitialState = Schema.encodeEffect(Schema.fromJsonString(State));
export const decodeThreadVmInitialState = Schema.decodeUnknownEffect(Schema.fromJsonString(State));
export const THREAD_VM_INITIAL_STATE_SECRET = "thread-vm-initial-state";

/** Read-only access for runtime credentials and activation, independent of offline bootstrap. */
export const readThreadVmInitialState = Effect.fn("ThreadVmInitialState.read")(function* () {
  const raw = yield* (yield* ServerSecretStore).get(THREAD_VM_INITIAL_STATE_SECRET);
  return Option.isSome(raw)
    ? yield* decodeThreadVmInitialState(new TextDecoder().decode(raw.value))
    : null;
});
