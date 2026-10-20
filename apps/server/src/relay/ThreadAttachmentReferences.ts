import * as Schema from "effect/Schema";
import {
  collectThreadAttachmentReferences as collect,
  ThreadAttachmentReferencesError,
} from "@t3tools/shared/threadAttachmentReferences";
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { ThreadAttachmentTransferError } from "./ThreadAttachmentTransfer.ts";

const isReferencesError = Schema.is(ThreadAttachmentReferencesError);
export const collectThreadAttachmentReferences = <E, R>(
  threadId: string,
  events: Stream.Stream<OrchestrationEvent, E, R>,
) =>
  collect(threadId, events).pipe(
    Effect.mapError((error) =>
      isReferencesError(error)
        ? new ThreadAttachmentTransferError({ message: error.message })
        : error,
    ),
  );
