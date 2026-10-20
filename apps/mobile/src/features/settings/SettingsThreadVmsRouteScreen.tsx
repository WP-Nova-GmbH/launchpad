import { PortableThreadLibrary } from "../threads/PortableThreadLibrary";
import { useAuth } from "@clerk/expo";
import {
  ManagedRelayTenancy,
  THREAD_VM_POLICY_FIELDS,
  THREAD_VM_POLICY_INPUT_ERROR,
  parseThreadVmPolicyDraft,
  threadVmPolicyDraft,
  type ThreadVmPolicyDraft,
} from "@t3tools/client-runtime/relay";
import type { ThreadVmPolicyRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import { decodedRelayClientError } from "../cloud/linkEnvironment";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsThreadVmsRouteScreen() {
  if (!hasCloudPublicConfig())
    return (
      <SettingsScreen title="Thread VMs">
        <Text className="p-5 text-base text-foreground-muted">
          Thread VMs require Launchpad Connect in this app build.
        </Text>
      </SettingsScreen>
    );
  return <ConfiguredThreadVmsSettings />;
}

function ConfiguredThreadVmsSettings() {
  const { userId, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  if (!isLoaded || !isSignedIn)
    return (
      <SettingsScreen title="Thread VMs">
        <Text className="p-5 text-base text-foreground-muted">
          {!isLoaded
            ? "Checking your account…"
            : "Sign in under Settings → Launchpad Account to view VM settings."}
        </Text>
      </SettingsScreen>
    );
  return <SignedInThreadVmsSettings key={userId} />;
}

function SignedInThreadVmsSettings() {
  const insets = useSafeAreaInsets();
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const [record, setRecord] = useState<ThreadVmPolicyRecord | null>(null);
  const [draft, setDraft] = useState<ThreadVmPolicyDraft | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const request = ++epoch.current;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const clerkToken = await getToken(resolveRelayClerkTokenOptions());
      if (!clerkToken) throw new Error("Sign in to Launchpad Connect first.");
      if (request !== epoch.current) return;
      const [membership, next] = await runtime.runPromise(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) =>
            Effect.all(
              [client.getOrganization({ clerkToken }), client.getThreadVmPolicy({ clerkToken })],
              { concurrency: 2 },
            ),
          ),
          Effect.mapError(decodedRelayClientError("Could not read the VM policy")),
        ),
      );
      if (request !== epoch.current) return;
      if (membership.organization.organizationId !== next.organizationId)
        throw new Error("Your organization changed. Reload the VM policy.");
      setRecord(next);
      setDraft(threadVmPolicyDraft(next.policy));
      setIsAdmin(membership.role === "admin");
    } catch (cause) {
      if (request === epoch.current)
        setError(cause instanceof Error ? cause.message : "Could not read the VM policy.");
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }, [getToken]);

  useEffect(() => {
    void load();
    return () => {
      epoch.current += 1;
    };
  }, [load]);

  const save = async () => {
    if (!record || !draft || !isAdmin || busy || !isSignedIn) return;
    let policy;
    try {
      policy = parseThreadVmPolicyDraft(draft);
    } catch {
      setError(THREAD_VM_POLICY_INPUT_ERROR);
      return;
    }
    const request = epoch.current;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const clerkToken = await getToken(resolveRelayClerkTokenOptions());
      if (!clerkToken) throw new Error("Sign in to Launchpad Connect first.");
      if (request !== epoch.current) return;
      const next = await runtime.runPromise(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) =>
            client.updateThreadVmPolicy({ clerkToken, payload: { ...record, policy } }),
          ),
          Effect.mapError(decodedRelayClientError("Could not save the VM policy")),
        ),
      );
      if (request !== epoch.current) return;
      setRecord(next);
      setDraft(threadVmPolicyDraft(next.policy));
      setSaved(true);
    } catch (cause) {
      if (request === epoch.current)
        setError(cause instanceof Error ? cause.message : "Could not save the VM policy.");
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  };

  return (
    <SettingsScreen title="Thread VMs">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <>
          <PortableThreadLibrary />
          <Text className="text-base text-foreground-muted">
            Each VM belongs to one thread.{" "}
            {isAdmin
              ? "These limits apply to everyone in your organization."
              : "An organization admin can change these limits."}
          </Text>
          {draft ? (
            <SettingsSection title="VM policy">
              {THREAD_VM_POLICY_FIELDS.map((field) => (
                <View key={field.key} className="gap-2 p-4">
                  <Text className="text-lg text-foreground">{field.label}</Text>
                  <Text className="text-sm text-foreground-muted">{field.description}</Text>
                  <AppTextInput
                    accessibilityLabel={field.label}
                    keyboardType="number-pad"
                    className="min-h-11 rounded-xl bg-subtle-strong px-3 text-base text-foreground"
                    editable={isAdmin && !busy}
                    value={draft[field.key]}
                    onChangeText={(value) => {
                      setDraft({ ...draft, [field.key]: value });
                      setSaved(false);
                    }}
                  />
                </View>
              ))}
              <View className="gap-2 p-4">
                <Text className="text-lg text-foreground">Calendar time zone</Text>
                <Text className="text-sm text-foreground-muted">
                  Weekday deletion and saved disk expiry use this time zone.
                </Text>
                <AppTextInput
                  accessibilityLabel="Calendar time zone"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-h-11 rounded-xl bg-subtle-strong px-3 text-base text-foreground"
                  editable={isAdmin && !busy}
                  value={draft.calendarTimeZone}
                  onChangeText={(value) => {
                    setDraft({ ...draft, calendarTimeZone: value });
                    setSaved(false);
                  }}
                />
              </View>
            </SettingsSection>
          ) : busy ? (
            <Text className="text-base text-foreground-muted">Loading VM policy…</Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-base text-danger">
              {error}
            </Text>
          ) : null}
          {saved ? (
            <Text accessibilityLiveRegion="polite" className="text-base text-foreground-muted">
              VM policy saved.
            </Text>
          ) : null}
          <View className="gap-3">
            {isAdmin ? (
              <MaterialButton
                label="Save policy"
                tone="primary"
                disabled={busy || !draft}
                onPress={() => void save()}
              />
            ) : null}
            <MaterialButton label="Reload policy" disabled={busy} onPress={() => void load()} />
          </View>
        </>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
