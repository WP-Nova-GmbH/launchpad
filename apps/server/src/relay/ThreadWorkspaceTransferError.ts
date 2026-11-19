import * as Schema from "effect/Schema";

export class ThreadWorkspaceTransferError extends Schema.TaggedError<ThreadWorkspaceTransferError>()(
  "ThreadWorkspaceTransferError",
  { message: Schema.String },
) {}
export const workspaceFailure = (message: string) => new ThreadWorkspaceTransferError({ message });
