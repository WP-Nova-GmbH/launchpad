import * as NodeCrypto from "node:crypto";

import { EnvironmentId, ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import type { RelayProjectCatalogPublishProofPayload } from "@t3tools/contracts/relay";
import { RELAY_PROJECT_CATALOG_PUBLISH_TYP, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  signRelayProjectCatalogPublishProof,
  toRelayProjectCatalogEntries,
} from "./OrganizationProjectCatalogRelay.ts";

const timestamp = "2026-08-24T12:00:00.000Z";

function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly canonicalKey?: string;
}): OrchestrationProjectShell {
  return {
    id: ProjectId.make(input.id),
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: input.canonicalKey
      ? {
          canonicalKey: input.canonicalKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${input.canonicalKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("OrganizationProjectCatalogRelay", () => {
  it("publishes project discovery fields without leaking workspace paths", () => {
    const entries = toRelayProjectCatalogEntries([
      project({
        id: "project-repository",
        title: "Repository project",
        workspaceRoot: "/srv/customer/private/repository",
        canonicalKey: "github.com/acme/repository",
      }),
      project({
        id: "project-local",
        title: "Local project",
        workspaceRoot: "/srv/customer/private/local",
      }),
    ]);

    expect(entries).toEqual([
      {
        projectId: ProjectId.make("project-repository"),
        title: "Repository project",
        repositoryCanonicalKey: "github.com/acme/repository",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        projectId: ProjectId.make("project-local"),
        title: "Local project",
        repositoryCanonicalKey: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("/srv/customer/private");
  });

  it.effect("signs a proof that covers the complete redacted snapshot", () =>
    Effect.gen(function* () {
      const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const environmentId = EnvironmentId.make("environment-1");
      const projects = toRelayProjectCatalogEntries([
        project({
          id: "project-1",
          title: "Catalog project",
          workspaceRoot: "/private/workspace",
          canonicalKey: "github.com/acme/catalog",
        }),
      ]);
      const payload = {
        iss: `t3-env:${environmentId}`,
        aud: "https://relay.example.test",
        sub: environmentId,
        jti: "catalog-jti-1",
        iat: 100,
        exp: 200,
        environmentId,
        revision: 42,
        projects,
      } satisfies RelayProjectCatalogPublishProofPayload;

      const proof = yield* signRelayProjectCatalogPublishProof({
        privateKey: keyPair.privateKey,
        payload,
      });
      const verified = yield* verifyRelayJwt({
        publicKey: keyPair.publicKey,
        token: proof,
        typ: RELAY_PROJECT_CATALOG_PUBLISH_TYP,
        issuer: `t3-env:${environmentId}`,
        audience: "https://relay.example.test",
        nowEpochSeconds: 150,
      });

      expect(verified).toMatchObject({ environmentId, revision: 42, projects });
    }),
  );
});
