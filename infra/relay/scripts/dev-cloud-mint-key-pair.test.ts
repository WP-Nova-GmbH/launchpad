// @effect-diagnostics nodeBuiltinImport:off - The test verifies synchronous startup persistence.
import { describe, expect, it } from "@effect/vitest";
import { signRelayJwt, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import {
  generateDevCloudMintKeyPair,
  loadOrCreateDevCloudMintKeyPair,
} from "./dev-cloud-mint-key-pair.ts";

describe("generateDevCloudMintKeyPair", () => {
  it.effect("produces a keypair that signs relay JWTs clients can verify", () =>
    Effect.gen(function* () {
      const keyPair = generateDevCloudMintKeyPair();
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "t3-dev-test+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "dev-user",
          iat: 100,
          exp: 200,
        },
      });

      const claims = yield* verifyRelayJwt({
        publicKey: keyPair.publicKey,
        token,
        typ: "t3-dev-test+jwt",
        issuer: "https://relay.example.test",
        audience: "https://relay.example.test",
        nowEpochSeconds: 150,
      });

      expect(claims.sub).toBe("dev-user");
    }),
  );

  it("reuses the same signing identity across relay restarts", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-key-"));
    const privateKeyPath = NodePath.join(directory, "cloud-mint-private.pem");

    try {
      const first = loadOrCreateDevCloudMintKeyPair(privateKeyPath);
      const second = loadOrCreateDevCloudMintKeyPair(privateKeyPath);

      expect(second).toEqual(first);
      expect(NodeFS.statSync(privateKeyPath).mode & 0o777).toBe(0o600);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
