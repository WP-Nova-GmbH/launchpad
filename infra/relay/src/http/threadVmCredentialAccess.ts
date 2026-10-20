import {
  RelayThreadArtifactReceipt,
  type RelayThreadVmCredentialScope,
} from "@t3tools/contracts/relay";

import * as Schema from "effect/Schema";
const isArtifactId = Schema.is(RelayThreadArtifactReceipt.fields.artifactId);

/** A VM principal cannot use generic machine, organization-secret or job endpoints. */
export function threadVmCredentialAllows(
  input: {
    readonly environmentId: string;
    readonly threadVm: RelayThreadVmCredentialScope;
  },
  method: string,
  url: string,
): boolean {
  let parts: Array<string>;
  try {
    parts = new URL(url, "https://relay.invalid").pathname.split("/").map(decodeURIComponent);
  } catch {
    return false;
  }
  // Discovery is scoped again by the handler to this credential's assigned thread.
  if (
    method === "POST" &&
    parts.length === 5 &&
    parts[0] === "" &&
    parts[1] === "v1" &&
    parts[2] === "environments" &&
    parts[3] === input.environmentId &&
    parts[4] === "thread-moves"
  )
    return true;
  if (
    parts[0] !== "" ||
    parts[1] !== "v1" ||
    parts[2] !== "environments" ||
    parts[3] !== input.environmentId ||
    parts[4] !== "threads" ||
    parts[5] !== input.threadVm.threadId
  )
    return false;
  if (parts[6] === "restores" && isArtifactId(parts[7]))
    return (
      method === "GET" && parts.length === 10 && parts[8] === "artifacts" && isArtifactId(parts[9])
    );
  if (parts[6] === "moves" && isArtifactId(parts[7])) {
    if (method === "GET")
      return parts.length === 10 && parts[8] === "artifacts" && isArtifactId(parts[9]);
    if (method !== "POST") return false;
    if (parts.length === 8) return true;
    return (
      parts.length === 9 &&
      ["begin", "freeze", "publish", "ready", "commit", "activate", "abort"].includes(parts[8]!)
    );
  }
  if (method === "PUT")
    return parts.length === 8 && parts[6] === "artifacts" && isArtifactId(parts[7]);
  if (method !== "POST") return false;
  if (parts.length === 7) return ["history", "final-save", "pause", "restore"].includes(parts[6]!);
  if (parts.length !== 8) return false;
  return (
    (parts[6] === "checkpoints" && ["native", "attachments"].includes(parts[7]!)) ||
    (parts[6] === "history" && parts[7] === "through") ||
    (parts[6] === "final-save" && ["freeze", "cancel"].includes(parts[7]!)) ||
    (parts[6] === "pause" && ["freeze", "activate", "cancel"].includes(parts[7]!)) ||
    (parts[6] === "endpoint" && (parts[7] === "recover" || parts[7] === "release")) ||
    (parts[6] === "setup" && parts[7] === "activate") ||
    (parts[6] === "restore" && parts[7] === "activate") ||
    (parts[6] === "access" && parts[7] === "check") ||
    (parts[6] === "credentials" && parts[7] === "github") ||
    (parts[6] === "repository" && parts[7] === "binding") ||
    (parts[6] === "commands" && (parts[7] === "next" || parts[7] === "ack")) ||
    (parts[6] === "work" && (parts[7] === "admit" || parts[7] === "complete"))
  );
}
