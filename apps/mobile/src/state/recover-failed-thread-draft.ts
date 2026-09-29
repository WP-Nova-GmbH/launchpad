import type { QueuedThreadMessage } from "./thread-outbox-model";
import { scopedThreadKey } from "../lib/scopedEntities";
import { restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContent,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  updateComposerDraftSettings,
} from "./use-composer-drafts";

/** Copy an uncertain submission without surrendering its original outbox ownership. */
export async function copyUncertainThreadDraft(message: QueuedThreadMessage): Promise<void> {
  const targetKey = restoredNewTaskDraftKey(message.messageId);
  await mergeComposerDraftContent(targetKey, {
    text: message.text,
    context: message.context,
    attachments: [],
    sourceShareId: `uncertain-submission:${message.commandId}`,
  });
  const existing = new Set(getComposerDraftSnapshot(targetKey).attachments.map((file) => file.id));
  appendComposerDraftAttachments(
    targetKey,
    message.attachments.filter((file) => !existing.has(file.id)),
    { allowOverflow: true },
  );
  updateComposerDraftSettings(targetKey, {
    ...(message.modelSelection ? { modelSelection: message.modelSelection } : {}),
    ...(message.runtimeMode ? { runtimeMode: message.runtimeMode } : {}),
    ...(message.interactionMode ? { interactionMode: message.interactionMode } : {}),
  });
  await flushComposerDrafts();
}

/** Move unsent setup edits into the restored task before reopening its editor. */
export async function recoverFailedThreadDraft(message: QueuedThreadMessage): Promise<void> {
  const sourceKey = scopedThreadKey(message.environmentId, message.threadId);
  const targetKey = restoredNewTaskDraftKey(message.messageId);
  const source = getComposerDraftSnapshot(sourceKey);
  if (source.text.length === 0 && source.attachments.length === 0) return;

  await mergeComposerDraftContent(targetKey, {
    text: source.text,
    context: source.context,
    attachments: [],
  });
  const existingIds = new Set(
    getComposerDraftSnapshot(targetKey).attachments.map((attachment) => attachment.id),
  );
  appendComposerDraftAttachments(
    targetKey,
    source.attachments.filter((attachment) => !existingIds.has(attachment.id)),
    { allowOverflow: true },
  );
  // Recovery may exceed the send cap. Preserve every file and let the editor
  // ask the user to remove extras; never discard them during a failed send.
  await flushComposerDrafts();
  clearComposerDraftContent(sourceKey);
}
