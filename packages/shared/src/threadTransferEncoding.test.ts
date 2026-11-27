import { expect, it } from "vite-plus/test";
import { ThreadTransferFormats } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import {
  normalizeThreadTransferFormats,
  threadTransferFormatForPolicy,
  threadTransferPolicyForFormat,
  THREAD_TRANSFER_SUPPORTED_FORMATS,
} from "./threadTransferEncoding.ts";

it("keeps absent legacy capabilities distinct from an explicitly empty intersection", () => {
  expect(normalizeThreadTransferFormats()).toEqual(["launchpad-thread-chunks-v1"]);
  expect(normalizeThreadTransferFormats(null)).toEqual(["launchpad-thread-chunks-v1"]);
  expect(normalizeThreadTransferFormats([])).toEqual([]);
});
it("canonicalizes capability set order and duplicates without changing the caller", () => {
  const offered = [
    "launchpad-thread-chunks-v2",
    "launchpad-thread-chunks-v1",
    "launchpad-thread-chunks-v2",
  ] as const;
  expect(normalizeThreadTransferFormats(offered)).toEqual(THREAD_TRANSFER_SUPPORTED_FORMATS);
  expect(offered).toHaveLength(3);
});
it("maps each fixed policy to exactly one wire format", () => {
  for (const format of THREAD_TRANSFER_SUPPORTED_FORMATS)
    expect(threadTransferFormatForPolicy(threadTransferPolicyForFormat(format))).toBe(format);
  expect(threadTransferPolicyForFormat("launchpad-thread-chunks-v1")).toBe("v1-64MiB");
  expect(threadTransferPolicyForFormat("launchpad-thread-chunks-v2")).toBe("workspace-raw-v2-8MiB");
});
it("requires bounded known format claims at the wire boundary", () => {
  const valid = Schema.is(ThreadTransferFormats);
  expect(valid(THREAD_TRANSFER_SUPPORTED_FORMATS)).toBe(true);
  for (const input of [
    [],
    ["unknown"],
    [...THREAD_TRANSFER_SUPPORTED_FORMATS, "launchpad-thread-chunks-v1"],
  ])
    expect(valid(input)).toBe(false);
});
