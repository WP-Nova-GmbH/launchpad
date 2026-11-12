import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PortableThreadLibrary } from "../threads/PortableThreadLibrary";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsVmThreadsRouteScreen() {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="VM threads">
      <View className="flex-1 px-5 pt-4" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <PortableThreadLibrary />
      </View>
    </SettingsScreen>
  );
}
