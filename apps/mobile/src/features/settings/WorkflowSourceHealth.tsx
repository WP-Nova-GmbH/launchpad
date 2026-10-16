import { useAuth } from "@clerk/expo";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import { type RelayRepositoryId, type WorkflowSourceHealthList } from "@t3tools/contracts/relay";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { AppText as Text } from "../../components/AppText";
import { runtime } from "../../lib/runtime";
import { resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";

export function WorkflowSourceHealth({
  repositoryId,
  focused,
}: {
  repositoryId: RelayRepositoryId;
  focused: boolean;
}) {
  const { getToken, userId } = useAuth();
  const key = (userId ?? "") + ":" + repositoryId;
  const [read, setRead] = useState<{
    key: string;
    data: WorkflowSourceHealthList | null;
    error: string | null;
  }>({ key, data: null, error: null });
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    const id = ++request.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    return getToken(resolveRelayClerkTokenOptions())
      .then(async (token) => {
        if (id !== request.current) return;
        if (!token) throw new Error("Sign in to read workflow sources.");
        const result = await runtime.runPromiseExit(
          WorkflowSources.client.pipe(Effect.flatMap((c) => c.health(token, repositoryId))),
          { signal: controller.signal },
        );
        if (id !== request.current) return;
        if (Exit.isFailure(result)) throw Cause.squash(result.cause);
        setRead({ key, data: result.value, error: null });
      })
      .catch((error) => {
        if (id === request.current)
          setRead((old) => ({
            key,
            data: WorkflowSources.accessRejected(error) ? null : old.key === key ? old.data : null,
            error: error instanceof Error ? error.message : "Could not read workflow sources.",
          }));
      });
  }, [key, getToken, repositoryId]);
  useEffect(() => {
    if (focused) void refresh();
    return () => {
      request.current++;
      abort.current?.abort();
    };
  }, [focused, refresh]);
  const data = read.key === key ? read.data : null;
  return (
    <SettingsSection title="Workflow sources">
      {read.key === key && read.error ? (
        <Text accessibilityRole="alert" className="p-4 text-danger-foreground">
          {read.error}
          {data ? " Showing last available status." : ""}
        </Text>
      ) : null}
      {!data && !(read.key === key && read.error) ? (
        <Text className="p-4 text-foreground-muted">
          {focused ? "Loading workflow sources…" : "Refresh to load workflow sources."}
        </Text>
      ) : null}
      {data?.sources.map((source) => (
        <Text key={source.connectionId} className="p-4 text-foreground">
          {source.workspaceName} · {WorkflowSources.sourceHealthLabel(source)}.{" "}
          {WorkflowSources.sourceDeliveryLabel(source)}
        </Text>
      ))}
      {data && !data.sources.length ? (
        <Text className="p-4 text-foreground-muted">No sources allowed for this repository.</Text>
      ) : null}
      <Text className="p-4 text-xs text-foreground-muted">
        Configure workflow sources in the web or desktop app. Starting and running work is managed
        separately.
      </Text>
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Refresh workflow sources"
        onPress={() => void refresh()}
      />
    </SettingsSection>
  );
}
