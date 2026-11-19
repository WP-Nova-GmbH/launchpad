import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OrchestrationMessage, ChatAttachment } from "@t3tools/contracts";
import { Button } from "../ui/button";

const SAVED_MARKDOWN_PLUGINS = [remarkGfm];
export const SavedConversationMessage = memo(function SavedConversationMessage({
  message,
  busy,
  onDownload,
}: {
  message: OrchestrationMessage;
  busy: boolean;
  onDownload: (file: ChatAttachment) => Promise<void>;
}) {
  const body = (
    <>
      <div className="break-words text-sm leading-relaxed [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_code]:font-mono [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
        <ReactMarkdown remarkPlugins={SAVED_MARKDOWN_PLUGINS}>{message.text}</ReactMarkdown>
      </div>
      {message.attachments?.length ? (
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
    <article className={message.role === "user" ? "ml-6 rounded-xl bg-muted/40 px-4 py-3" : "px-1"}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {message.author?.displayName ??
            (message.role === "user" ? "You" : message.role === "system" ? "System" : "Assistant")}
        </span>
        <time
          dateTime={message.createdAt}
          aria-label={new Date(message.createdAt).toLocaleString()}
        >
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
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
