import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText as Text } from "./AppText";

export function ErrorBanner({
  message,
  title,
  children,
  tone = "error",
}: {
  readonly message: string;
  readonly title?: string;
  readonly children?: ReactNode;
  readonly tone?: "error" | "warning";
}) {
  const textColor = tone === "warning" ? "text-warning-foreground" : "text-danger-foreground";
  return (
    <View
      accessibilityRole="alert"
      className={`gap-2 rounded-2xl border px-3.5 py-3 ${tone === "warning" ? "border-warning-border bg-warning" : "border-danger-border bg-danger"}`}
    >
      {title ? (
        <Text accessibilityRole="header" className={`font-t3-medium text-sm ${textColor}`}>
          {title}
        </Text>
      ) : null}
      <Text className={`text-sm ${!title ? "font-t3-medium" : ""} ${textColor}`}>{message}</Text>
      {children ? <View className="flex-row flex-wrap gap-2">{children}</View> : null}
    </View>
  );
}
