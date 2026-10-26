import { useState } from "react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { Image, Modal, Pressable, ScrollView, View } from "react-native";
import {
  threadPresenceInitials,
  threadPresenceLabel,
  threadPresenceName,
  type ThreadPresencePerson,
} from "@t3tools/client-runtime/state/threadPresence";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import {
  useThreadPresencePeople,
  useThreadPresenceParticipants,
} from "../../state/thread-presence";

function PresenceAvatar({ person }: { person: ThreadPresencePerson }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return (
    <View className="size-8 items-center justify-center overflow-hidden rounded-full bg-subtle-strong">
      {person.imageUrl && person.imageUrl !== failedImage ? (
        <Image
          source={{ uri: person.imageUrl }}
          className="size-full"
          onError={() => setFailedImage(person.imageUrl)}
        />
      ) : (
        <Text className="text-xs font-t3-medium text-foreground">
          {threadPresenceInitials(person)}
        </Text>
      )}
    </View>
  );
}
type ThreadPresenceProps = {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
};

export function ThreadPresence(props: ThreadPresenceProps) {
  const key =
    props.environmentId !== null && props.threadId !== null
      ? threadKey({ environmentId: props.environmentId, threadId: props.threadId })
      : "none";
  return <ThreadPresenceContent key={key} {...props} />;
}

function ThreadPresenceContent({ environmentId, threadId }: ThreadPresenceProps) {
  const people = useThreadPresencePeople(environmentId, threadId);
  const participants = useThreadPresenceParticipants(environmentId, threadId);
  const [open, setOpen] = useState(false);
  const label = threadPresenceLabel(people);
  if (!label && !open) return null;
  return (
    <>
      {label ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`View thread participants. ${label}`}
          onPress={() => setOpen(true)}
          className="mb-2 self-center flex-row items-center gap-2 rounded-full bg-grouped-card px-3 py-1.5"
        >
          <View className="flex-row gap-1">
            {people.slice(0, 3).map((person) => (
              <PresenceAvatar key={person.key} person={person} />
            ))}
          </View>
          {people.length > 3 ? (
            <Text className="text-xs text-foreground">+{people.length - 3}</Text>
          ) : null}
          {people.some((person) => person.typing) ? (
            <Text className="text-xs text-foreground-muted">{label}</Text>
          ) : null}
        </Pressable>
      ) : null}
      <Modal
        visible={open}
        onRequestClose={() => setOpen(false)}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <View accessibilityViewIsModal className="flex-1 gap-5 bg-background px-5 pb-6 pt-12">
          <Text accessibilityRole="header" className="text-xl font-t3-bold text-foreground">
            Thread participants
          </Text>
          <ScrollView className="flex-1">
            <View className="gap-5">
              {participants.map((person) => (
                <View key={person.key} className="flex-row gap-3">
                  <PresenceAvatar person={person} />
                  <View className="flex-1 gap-1">
                    <Text className="font-t3-medium text-foreground">
                      {threadPresenceName(person)}
                      {person.isSelf ? " · You" : ""}
                    </Text>
                    {person.email ? (
                      <Text className="text-sm text-foreground-muted">{person.email}</Text>
                    ) : null}
                    {person.userId && !person.displayName && !person.email ? (
                      <Text className="text-sm text-foreground-muted">
                        Account: {person.userId}
                      </Text>
                    ) : null}
                    {!person.userId ? (
                      <Text className="text-sm text-foreground-muted">{person.clientDetails}</Text>
                    ) : null}
                    {person.typing ? (
                      <Text className="text-sm text-foreground-muted">Typing…</Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
          <MaterialButton label="Close" onPress={() => setOpen(false)} fullWidth />
        </View>
      </Modal>
    </>
  );
}
