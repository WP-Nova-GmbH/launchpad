import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import Constants from "expo-constants";

type RelayConfigExtra = {
  readonly relay?: { readonly url?: unknown };
};

export function resolveConfiguredRelayUrl(
  extra: RelayConfigExtra | undefined = Constants.expoConfig?.extra,
) {
  const url = extra?.relay?.url;
  return normalizeSecureRelayUrl(typeof url === "string" ? url : "");
}
