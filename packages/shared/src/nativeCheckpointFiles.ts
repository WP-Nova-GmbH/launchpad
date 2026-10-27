import type { ThreadNativeCheckpointArchiveManifest as Header } from "@t3tools/contracts/relay";

/** The only files a retained native conversation may contain; credentials never belong here. */
export function nativeCheckpointFiles(
  header: Pick<Header, "native" | "nativeManifestSha256" | "directories">,
) {
  const native = header.native,
    files = native.files ?? [];
  if (
    new Set(files.map((f) => f.name)).size !== files.length ||
    new Set(files.map((f) => f.sourcePath)).size !== files.length ||
    files.reduce((n, f) => n + f.sizeBytes, 0) > 64 * 1024 * 1024 ||
    (native.format === "codex-rollout-v1" ? files.length > 0 : native.files === undefined)
  )
    return null;
  const expected = new Map<string, { readonly sha256: string; readonly sizeBytes?: number }>([
    ["manifest.json", { sha256: header.nativeManifestSha256 }],
    ["rollout.jsonl", { sha256: native.sha256 }],
    ...files.map((file): [string, { sha256: string; sizeBytes: number }] => [
      `files/${file.name}`,
      { sha256: file.sha256, sizeBytes: file.sizeBytes },
    ]),
  ]);
  if (native.format === "codex-rollout-v3") {
    const rollouts = native.rollouts,
      heads = native.heads;
    const root = rollouts?.find((r) => r.rolloutName === native.rolloutName);
    if (
      !rollouts?.length ||
      !heads ||
      heads[native.threadId] !== native.rolloutName ||
      Object.keys(heads).length > 256 ||
      !root ||
      root.sha256 !== native.sha256 ||
      new Set(rollouts.map((r) => r.rolloutName)).size !== rollouts.length ||
      rollouts.reduce((n, r) => n + r.sizeBytes, 0) > 256 * 1024 * 1024 ||
      Object.values(heads).some((name) => !rollouts.some((r) => r.rolloutName === name))
    )
      return null;
    for (const rollout of rollouts)
      expected.set(
        rollout.rolloutName === native.rolloutName
          ? "rollout.jsonl"
          : `native-rollouts/${rollout.rolloutName}`,
        rollout,
      );
  } else if (
    native.heads !== undefined ||
    native.rollouts !== undefined ||
    !native.rolloutName.endsWith(`-${native.threadId}.jsonl`)
  )
    return null;
  const declared = new Set<string>(header.directories);
  if (
    declared.size !== header.directories.length ||
    (files.length > 0 && !declared.has("files")) ||
    ([...expected.keys()].some((key) => key.startsWith("native-rollouts/")) &&
      !declared.has("native-rollouts"))
  )
    return null;
  return { files: expected, directories: declared };
}
