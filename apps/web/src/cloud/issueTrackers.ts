import { useAuth } from "@clerk/react";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import type {
  RelaySelectJiraSiteRequest,
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
  const mutationPending = useRef(false);
  const uncertain = useRef(false);
  const [mutating, setMutating] = useState(false);
  const [unverified, setUnverified] = useState(false);

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

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const result = await call("Could not load issue trackers", (client, clerkToken) =>
        client.listIssueTrackerConnections({ clerkToken }),
      );
      if (version === requestVersion.current) {
        setSnapshot(result);
        uncertain.current = false;
        setUnverified(false);
      }
    } catch (cause) {
      if (version === requestVersion.current) {
        setError(cause instanceof Error ? cause.message : "Could not load issue trackers.");
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [call]);

  const refresh = useCallback(async () => {
    // Focus events during an OAuth launch or a mutation must not race its result.
    if (!mutationPending.current) await load();
  }, [load]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      requestVersion.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const mutate = async <A>(action: () => Promise<A>, apply: (result: A) => void) => {
    if (mutationPending.current || uncertain.current) {
      throw new Error("Refresh to verify the current connection before changing it.");
    }
    mutationPending.current = true;
    setMutating(true);
    ++requestVersion.current;
    setLoading(false);
    setError(null);
    try {
      const result = await action();
      ++requestVersion.current;
      apply(result);
      return result;
    } catch (cause) {
      // The server may have committed even when its response was lost. Reconcile
      // before allowing another action; never replay the mutation automatically.
      ++requestVersion.current;
      uncertain.current = true;
      setUnverified(true);
      await load();
      throw cause;
    } finally {
      mutationPending.current = false;
      setMutating(false);
    }
  };

  const startLinear = () =>
    mutate(
      () =>
        call("Could not start connecting Linear", (client, clerkToken) =>
          client.startLinearAuthorization({ clerkToken }),
        ),
      (result) =>
        setSnapshot(
          (current) =>
            current && {
              ...current,
              connections: [
                ...current.connections.filter((entry) => entry.service !== "linear"),
                result.connection,
              ],
            },
        ),
    );

  const startJira = () =>
    mutate(
      () =>
        call("Could not start connecting Jira", (client, clerkToken) =>
          client.startJiraAuthorization({ clerkToken }),
        ),
      (result) =>
        setSnapshot(
          (current) =>
            current && {
              ...current,
              connections: [
                ...current.connections.filter((entry) => entry.service !== "jira"),
                result.connection,
              ],
            },
        ),
    );

  const selectJiraSite = async (payload: RelaySelectJiraSiteRequest) => {
    await mutate(
      () =>
        call("Could not connect the Jira site", (client, clerkToken) =>
          client.selectJiraSite({ clerkToken, payload }),
        ),
      setSnapshot,
    );
  };
  const cancelJiraSelection = async (authorizationId: string) => {
    await mutate(
      () =>
        call("Could not cancel Jira setup", (client, clerkToken) =>
          client.cancelJiraSelection({ clerkToken, authorizationId }),
        ),
      setSnapshot,
    );
  };

  const disconnect = async (service: RelayIssueTrackerService) => {
    await mutate(
      () =>
        call("Could not disconnect the issue tracker", (client, clerkToken) =>
          client.disconnectIssueTracker({ clerkToken, service }),
        ),
      () =>
        setSnapshot(
          (current) =>
            current && {
              ...current,
              connections: current.connections.filter((entry) => entry.service !== service),
            },
        ),
    );
  };

  const confirmLinearReplacement = async (proposalId: string) => {
    await mutate(
      () =>
        call("Could not replace the Linear workspace", (client, clerkToken) =>
          client.confirmLinearReplacement({ clerkToken, proposalId }),
        ),
      setSnapshot,
    );
  };
  const cancelLinearReplacement = async (proposalId: string) => {
    await mutate(
      () =>
        call("Could not cancel the workspace change", (client, clerkToken) =>
          client.cancelLinearReplacement({ clerkToken, proposalId }),
        ),
      setSnapshot,
    );
  };

  return {
    snapshot,
    loading,
    error,
    mutating,
    unverified,
    refresh,
    startLinear,
    startJira,
    selectJiraSite,
    cancelJiraSelection,
    disconnect,
    confirmLinearReplacement,
    cancelLinearReplacement,
  };
}
