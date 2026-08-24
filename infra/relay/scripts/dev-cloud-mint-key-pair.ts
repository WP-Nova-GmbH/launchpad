// @effect-diagnostics nodeBuiltinImport:off - Startup key persistence is a synchronous Node boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * The deployed relay receives this keypair from Alchemy. Local development
 * needs the same valid Ed25519 shape so clients and enrolled machines can
 * verify the relay proofs they receive during connection setup.
 */
export function generateDevCloudMintKeyPair(): {
  readonly privateKey: string;
  readonly publicKey: string;
} {
  return NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
}

/**
 * Keep one development signing identity across relay restarts. Enrolled
 * executors pin the public key returned during enrollment, so rotating this
 * pair every time the local relay starts makes every existing machine reject
 * the next connection token.
 */
export function loadOrCreateDevCloudMintKeyPair(privateKeyPath: string): {
  readonly privateKey: string;
  readonly publicKey: string;
} {
  NodeFS.mkdirSync(NodePath.dirname(privateKeyPath), { recursive: true });

  let privateKey: string;
  try {
    privateKey = NodeFS.readFileSync(privateKeyPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }

    const generated = generateDevCloudMintKeyPair();
    try {
      NodeFS.writeFileSync(privateKeyPath, generated.privateKey, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      privateKey = generated.privateKey;
    } catch (writeError) {
      if (
        !(writeError instanceof Error) ||
        !("code" in writeError) ||
        writeError.code !== "EEXIST"
      ) {
        throw writeError;
      }
      privateKey = NodeFS.readFileSync(privateKeyPath, "utf8");
    }
  }

  const publicKey = NodeCrypto.createPublicKey(privateKey)
    .export({
      format: "pem",
      type: "spki",
    })
    .toString();
  return { privateKey, publicKey };
}
