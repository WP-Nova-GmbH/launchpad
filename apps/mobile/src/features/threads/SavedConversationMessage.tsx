import { memo } from "react";
import type { ChatAttachment, OrchestrationMessage } from "@t3tools/contracts";
import { Markdown } from "react-native-nitro-markdown";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

/** Read-only Markdown uses retained attachments, never a connection to the VM. */
export const SavedConversationMessage = memo(function SavedConversationMessage({
  message,
  expanded,
  onToggle,
  busy,
  onDownload,
}: {
  message: OrchestrationMessage;
  expanded: boolean;
  onToggle: (messageId: string) => void;
  busy: boolean;
  onDownload: (file: ChatAttachment) => Promise<void>;
}) {
  const theme = useUniwindTheme();
  return (
    <View
      className={message.role === "user" ? "ml-4 gap-2 rounded-xl bg-card p-3" : "gap-2 px-1 py-3"}
    >
      <View className="flex-row flex-wrap items-baseline gap-3">
        <Text className="text-xs font-medium text-foreground">
          {message.author?.displayName ??
            (message.role === "user" ? "You" : message.role === "system" ? "System" : "Assistant")}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Text>
      </View>
      {message.role === "reasoning" && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: expanded }}
          onPress={() => onToggle(message.id)}
          className="min-h-11 flex-row items-center gap-2"
        >
          <SymbolView name={expanded ? "chevron.down" : "chevron.right"} size={12} />
          <Text className="text-xs text-foreground-muted">Reasoning</Text>
        </Pressable>
      )}
      {(message.role !== "reasoning" || expanded) && (
        <>
          <Markdown
            options={{ gfm: true }}
            theme={{
              colors: {
                text: theme["--color-foreground"],
                heading: theme["--color-foreground"],
                code: theme["--color-md-code-text"],
                codeBackground: theme["--color-md-code-bg"],
                link: theme["--color-md-link"],
                border: theme["--color-border"],
              },
              fontSizes: { m: 14 },
            }}
          >
            {message.text}
          </Markdown>
          {message.attachments?.map((file) => (
            <Pressable
              accessibilityRole="button"
              className="min-h-11 justify-center rounded-lg bg-card px-3 py-2"
              key={file.id}
              disabled={busy || (file.type !== "image" && file.type !== "file")}
              onPress={() => void onDownload(file)}
            >
              <Text className="text-sm text-foreground">{file.name}</Text>
            </Pressable>
          ))}
        </>
      )}
    </View>
  );
});
