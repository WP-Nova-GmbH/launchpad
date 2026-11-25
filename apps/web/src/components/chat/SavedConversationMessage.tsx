import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { DownloadIcon, FileTextIcon, ImageIcon, RefreshCwIcon } from "lucide-react";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OrchestrationMessage, ChatAttachment } from "@t3tools/contracts";
import { parseTimestampDate } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export type AttachmentDownloadState = "downloading" | "failed";

const SAVED_MARKDOWN_PLUGINS = [remarkGfm];

const SavedMessageMarkdown = memo(ReactMarkdown);

export const SavedConversationMessage = memo(function SavedConversationMessage({
  message,
  busy,
  attachmentDownloads,
  viewerAccountId,
  timeZone,
  onDownload,
}: {
  message: OrchestrationMessage;
  busy: boolean;
  attachmentDownloads?: ReadonlyMap<string, AttachmentDownloadState>;
  viewerAccountId?: string;
  timeZone?: string;
  onDownload: (file: ChatAttachment) => Promise<void>;
}) {
  const isUser = message.role === "user";
  const workflowTranscript = viewerAccountId !== undefined;
  const workflowPrompt =
    workflowTranscript && isUser && message.workflowOrigin?.kind === "automation";
  const roleLabel = isUser ? "You" : message.role === "system" ? "System" : "Assistant";
  let authorLabel = message.author?.displayName ?? roleLabel;
  if (workflowTranscript) {
    authorLabel = roleLabel;
    if (workflowPrompt) authorLabel = "Workflow";
    else if (isUser && message.author?.userId !== viewerAccountId)
      authorLabel = message.author?.displayName ?? "Unknown author";
  }
  const messageClass = workflowPrompt
    ? "border-s-2 border-border/60 ps-3"
    : isUser
      ? "ml-6 rounded-xl bg-muted/40 px-4 py-3"
      : "px-1";

  const sentAt = parseTimestampDate(message.createdAt);
  const body = (
    <>
      <div className="break-words text-sm leading-relaxed [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_code]:font-mono [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
        <SavedMessageMarkdown remarkPlugins={SAVED_MARKDOWN_PLUGINS}>
          {message.text}
        </SavedMessageMarkdown>
      </div>
      {message.attachments?.length && attachmentDownloads ? (
        <ul
          aria-label="Attachments"
          className="mt-2 divide-y divide-border/60 border-y border-border/60"
        >
          {message.attachments.map((file) => {
            const canDownload = file.type === "image" || file.type === "file";
            const state = attachmentDownloads.get(file.id);
            const downloading = state === "downloading";
            const failed = state === "failed";
            const disabled = downloading || (busy && !failed);
            const label = downloading ? "Downloading…" : failed ? "Retry download" : "Download";
            const FileIcon = file.type === "image" ? ImageIcon : FileTextIcon;

            return (
              <li key={file.id} className="flex items-center gap-2 py-1.5">
                <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium whitespace-pre-wrap wrap-anywhere">
                    {file.name}
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                    <span>{formatAttachmentSize(file.sizeBytes)}</span>
                    <span role="status">
                      {downloading ? (
                        <span className="sr-only">Downloading {file.name}</span>
                      ) : failed ? (
                        <span className="text-destructive-foreground">
                          Download failed<span className="sr-only"> for {file.name}</span>
                        </span>
                      ) : null}
                    </span>
                  </div>
                </div>
                {canDownload ? (
                  <Button
                    size="compact"
                    variant={downloading ? "ghost" : "outline"}
                    data-saved-attachment-download=""
                    aria-label={`${label} ${file.name}`}
                    aria-disabled={disabled || undefined}
                    onClick={() => {
                      if (!disabled) void onDownload(file);
                    }}
                  >
                    {downloading ? (
                      <Spinner aria-hidden aria-label={undefined} role={undefined} />
                    ) : failed ? (
                      <RefreshCwIcon aria-hidden />
                    ) : (
                      <DownloadIcon aria-hidden />
                    )}
                    {label}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">Download unavailable</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : message.attachments?.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {message.attachments.map((file) => (
            <Button
              key={file.id}
              size="xs"
              variant="secondary"
              disabled={busy || (file.type !== "image" && file.type !== "file")}
              onClick={() => void onDownload(file)}
            >
              {file.name}
            </Button>
          ))}
        </div>
      ) : null}
    </>
  );
  return (
    <article className={messageClass}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{authorLabel}</span>
        {sentAt ? (
          <time
            dateTime={message.createdAt}
            aria-label={sentAt.toLocaleString(undefined, { timeZone })}
          >
            {sentAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone })}
          </time>
        ) : (
          <span>Time unavailable</span>
        )}
      </div>
      {message.role === "reasoning" ? (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer py-1 text-xs">Reasoning</summary>
          {body}
        </details>
      ) : (
        body
      )}
    </article>
  );
});
