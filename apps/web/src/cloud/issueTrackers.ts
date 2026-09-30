import { useAuth } from "@clerk/react";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import type {
  RelayConnectJiraRequest,
  RelayIssueTrackerConnections,
  RelayIssueTrackerService,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useRef, useState } from "react";

import { runtime } from "../lib/runtime";
import { decodedRelayClientError } from "./linkEnvironment";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type TenancyClient = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];

/** Organization settings own this hook so leaving the organization discards its metadata. */
export function useIssueTrackers() {
  const { getToken } = useAuth();
  const [snapshot, setSnapshot] = useState<RelayIssueTrackerConnections | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const call = useCallback(
    async <A>(
      description: string,
      run: (
        client: TenancyClient,
        clerkToken: string,
      ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
    ): Promise<A> => {
      const clerkToken = await getToken(resolveRelayClerkTokenOptions());
      if (!clerkToken) throw new Error("Sign in to Launchpad Connect first.");
      return runtime.runPromise(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) => run(client, clerkToken)),
          Effect.mapError(decodedRelayClientError(description)),
        ),
      );
    },
    [getToken],
  );

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const result = await call("Could not load issue trackers", (client, clerkToken) =>
        client.listIssueTrackerConnections({ clerkToken }),
      );
      if (version === requestVersion.current) setSnapshot(result);
    } catch (cause) {
      if (version === requestVersion.current) {
        setError(cause instanceof Error ? cause.message : "Could not load issue trackers.");
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      requestVersion.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const startLinear = async () => {
    const result = await call("Could not start connecting Linear", (client, clerkToken) =>
      client.startLinearAuthorization({ clerkToken }),
    );
    await refresh();
    return result;
  };

  const connectJira = async (payload: RelayConnectJiraRequest) => {
    const connection = await call("Could not connect Jira", (client, clerkToken) =>
      client.connectJira({ clerkToken, payload }),
    );
    // A list started before the mutation must not restore old connection state.
    requestVersion.current += 1;
    setLoading(false);
    setError(null);
    setSnapshot(
      (current) =>
        current && {
          ...current,
          connections: [
            ...current.connections.filter((entry) => entry.service !== "jira"),
            connection,
          ],
        },
    );
  };

  const disconnect = async (service: RelayIssueTrackerService) => {
    await call("Could not disconnect the issue tracker", (client, clerkToken) =>
      client.disconnectIssueTracker({ clerkToken, service }),
    );
    requestVersion.current += 1;
    setLoading(false);
    setError(null);
    setSnapshot(
      (current) =>
        current && {
          ...current,
          connections: current.connections.filter((entry) => entry.service !== service),
        },
    );
  };

  return { snapshot, loading, error, refresh, startLinear, connectJira, disconnect };
}
