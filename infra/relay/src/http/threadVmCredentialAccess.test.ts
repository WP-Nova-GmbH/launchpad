import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { threadVmCredentialAllows } from "./threadVmCredentialAccess.ts";

const principal = {
  environmentId: "vm-env",
  threadVm: {
    allocationId: "allocation",
    threadId: ThreadId.make("private-thread"),
    repositoryId: "repo",
    generation: 2,
  },
};
const path = "/v1/environments/vm-env/threads/private-thread";
describe("thread VM credential HTTP boundary", () => {
  it("permits only the assigned thread's command/history/work protocol", () => {
    expect(threadVmCredentialAllows(principal, "POST", path + "/credentials/github")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/repository/binding")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/history")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/final-save")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/pause")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/pause/freeze")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/pause/activate")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/pause/cancel")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/final-save/cancel")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/final-save/freeze")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/history/through")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/endpoint/recover")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/endpoint/release")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/access/check")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/setup/activate")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/commands/ack")).toBe(true);
    expect(threadVmCredentialAllows(principal, "POST", path + "/work/admit")).toBe(true);
    for (const forbidden of [
      "/v1/environments/vm-env/threads/another-thread/history",
      "/v1/environments/another-env/threads/private-thread/history",
      "/v1/environments/vm-env/provider-accounts",
      "/v1/environments/vm-env/jobs",
      "/v1/organization/skills",
      path + "/repository/binding/extra",
      path + "/repository/another",
      path + "/credentials/provider-accounts",
      path + "/credentials/github/extra",
      path + "/history/extra",
      path + "/final-save/delete",
      path + "/pause/activate/extra",
      path + "/pause/cancel/extra",
      path + "/final-save/cancel/extra",
      path + "/pause/freeze/extra",
      "/v1/environments/vm-env/threads/another-thread/pause",
      path + "/final-save/freeze/extra",
      "/v1/environments/vm-env/threads/another-thread/final-save",
      path + "/setup/activate/extra",
      path + "/setup/reset",
      path + "/endpoint/recover/extra",
      path + "/endpoint/configure",
      path + "/access/check/extra",
      path + "/access/grant",
      path + "/commands/ack/",
      path + "/work%2Fadmit",
      path + "/history/%zz",
      path + "/../../provider-accounts",
    ])
      expect(threadVmCredentialAllows(principal, "POST", forbidden)).toBe(false);
    expect(threadVmCredentialAllows(principal, "GET", path + "/history")).toBe(false);
  });
});

it("permits streamed checkpoints and moves only for the assigned thread", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  expect(threadVmCredentialAllows(principal, "POST", "/v1/environments/vm-env/thread-moves")).toBe(
    true,
  );
  expect(threadVmCredentialAllows(principal, "POST", path + "/checkpoints/native")).toBe(true);
  expect(threadVmCredentialAllows(principal, "POST", path + "/checkpoints/attachments")).toBe(true);
  expect(threadVmCredentialAllows(principal, "PUT", path + "/artifacts/" + id)).toBe(true);
  expect(
    threadVmCredentialAllows(principal, "GET", path + "/moves/" + id + "/artifacts/" + id),
  ).toBe(true);
  for (const action of [
    "",
    "/begin",
    "/freeze",
    "/publish",
    "/ready",
    "/commit",
    "/activate",
    "/abort",
  ])
    expect(threadVmCredentialAllows(principal, "POST", path + "/moves/" + id + action)).toBe(true);
  for (const [method, url] of [
    ["POST", path + "/moves/" + id + "/removed"],
    ["POST", path + "/moves/" + id + "/reset"],
    ["POST", path + "/moves/bad/activate"],
    ["DELETE", path + "/artifacts/" + id],
    ["GET", path + "/artifacts/" + id],
    ["PUT", path + "/artifacts/not-a-uuid"],
    ["GET", path + "/moves/" + id + "/artifacts/" + id + "/extra"],
    ["POST", "/v1/environments/another-env/thread-moves"],
    ["GET", "/v1/environments/vm-env/thread-moves"],
    ["PUT", "/v1/environments/vm-env/threads/another-thread/artifacts/" + id],
    ["GET", path + "/moves/" + id + "/artifacts%2F" + id],
  ] as const)
    expect(threadVmCredentialAllows(principal, method, url)).toBe(false);
});

it("permits only this thread's exact restore discovery and UUID artifact paths", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  expect(threadVmCredentialAllows(principal, "POST", path + "/restore")).toBe(true);
  expect(
    threadVmCredentialAllows(principal, "GET", path + "/restores/" + id + "/artifacts/" + id),
  ).toBe(true);
  for (const [method, url] of [
    ["GET", path + "/restore"],
    ["POST", path + "/restore/extra"],
    ["POST", path + "/restores/" + id + "/activate"],
    ["GET", path + "/restores/bad/artifacts/" + id],
    ["GET", path + "/restores/" + id + "/artifacts/bad"],
    ["GET", path + "/restores/" + id + "/artifacts/" + id + "/extra"],
    [
      "GET",
      path.replace("private-thread", "other-thread") + "/restores/" + id + "/artifacts/" + id,
    ],
  ] as const)
    expect(threadVmCredentialAllows(principal, method, url)).toBe(false);
});
