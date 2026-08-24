import type { OrchestrationProjectShell } from "@t3tools/contracts";
import {
  RelayApi,
  type RelayProjectCatalogEntry,
  type RelayProjectCatalogPublishProofPayload,
} from "@t3tools/contracts/relay";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_PROJECT_CATALOG_PUBLISH_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import { readInstalledMachineIdentity } from "../cloud/machineEnrollment.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";

export class OrganizationProjectCatalogRelay extends Context.Service<
  OrganizationProjectCatalogRelay,
  {
    readonly publishSnapshot: () => Effect.Effect<boolean>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/relay/OrganizationProjectCatalogRelay") {}

export function toRelayProjectCatalogEntries(
  projects: ReadonlyArray<OrchestrationProjectShell>,
): ReadonlyArray<RelayProjectCatalogEntry> {
  return projects.map((project) => ({
    projectId: project.id,
    title: project.title,
    repositoryCanonicalKey: project.repositoryIdentity?.canonicalKey ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }));
}

export function signRelayProjectCatalogPublishProof(input: {
  readonly privateKey: string;
  readonly payload: RelayProjectCatalogPublishProofPayload;
}) {
  return signRelayJwt({
    privateKey: input.privateKey,
    typ: RELAY_PROJECT_CATALOG_PUBLISH_TYP,
    payload: input.payload,
  });
}

function relayEnvironmentClient(token: string) {
  return HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const environmentKeyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  const publishedRevisionRef = yield* Ref.make(-1);

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
      );

  const readRelayConfig = Effect.gen(function* () {
    const [url, issuer, environmentCredential, machineIdentity] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ISSUER_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      readInstalledMachineIdentity(secrets),
    ]);
    return url && environmentCredential && machineIdentity?.role === "agent_executor"
      ? { url, issuer: issuer ?? url, environmentCredential }
      : null;
  });

  const publishSnapshotUnsafe = Effect.fn("publishOrganizationProjectCatalogUnsafe")(function* () {
    const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
    if (relayConfig === null) {
      yield* Effect.logDebug(
        "organization project catalog publish skipped; managed machine credentials unavailable",
      );
      return false;
    }
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    if ((yield* Ref.get(publishedRevisionRef)) >= snapshot.snapshotSequence) {
      return true;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const projects = toRelayProjectCatalogEntries(snapshot.projects);
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: 5 });
    const proofPayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayConfig.issuer),
      sub: environmentId,
      jti: yield* crypto.randomUUIDv4,
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
      environmentId,
      revision: snapshot.snapshotSequence,
      projects,
    } satisfies RelayProjectCatalogPublishProofPayload;
    const proof = yield* signRelayProjectCatalogPublishProof({
      privateKey: environmentKeyPair.privateKey,
      payload: proofPayload,
    });
    const relayClient = yield* HttpApiClient.make(RelayApi, {
      baseUrl: relayConfig.url,
      transformClient: relayEnvironmentClient(relayConfig.environmentCredential),
    }).pipe(Effect.provide(FetchHttpClient.layer));
    const response = yield* relayClient.projectCatalogServer.publishProjectCatalog({
      params: { environmentId },
      payload: {
        revision: snapshot.snapshotSequence,
        projects,
        proof,
      },
    });
    yield* Ref.set(publishedRevisionRef, response.acceptedRevision);
    yield* Effect.logInfo("organization project catalog published", {
      environmentId,
      revision: snapshot.snapshotSequence,
      acceptedRevision: response.acceptedRevision,
      projectCount: projects.length,
    });
    return true;
  });

  const publishSnapshot: OrganizationProjectCatalogRelay["Service"]["publishSnapshot"] = () =>
    publishSnapshotUnsafe().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("organization project catalog publish failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
      Effect.withSpan("OrganizationProjectCatalogRelay.publishSnapshot"),
      withRelayClientTracing,
    );

  const worker = yield* makeDrainableWorker(() =>
    Effect.gen(function* () {
      while (!(yield* publishSnapshot())) {
        yield* Effect.sleep("5 seconds");
      }
    }),
  );

  const start: OrganizationProjectCatalogRelay["Service"]["start"] = Effect.fn(
    "OrganizationProjectCatalogRelay.start",
  )(function* () {
    yield* worker.enqueue(undefined);
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.aggregateKind === "project" ? worker.enqueue(undefined) : Effect.void,
      ),
    );
  });

  return OrganizationProjectCatalogRelay.of({ publishSnapshot, start });
});

export const layer = Layer.effect(OrganizationProjectCatalogRelay, make);
