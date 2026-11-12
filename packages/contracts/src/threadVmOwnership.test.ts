import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  DEFAULT_WORKFLOW_VM_LIMIT,
  RelayThreadPlacement,
  WorkflowVmPolicyRecord,
  isAssignedThreadPlacement,
  isPrivateThreadPlacement,
} from "./threadVm.ts";

const privatePlacement = {
  threadId: "thread",
  organizationId: "organization",
  repositoryId: "repository",
  ownerUserId: "person",
  environmentId: "environment",
  projectId: "project",
  generation: 1,
  operationId: null,
};
const preparation = {
  ...privatePlacement,
  audience: "repository",
  ownerUserId: null,
  workflowJobId: "job",
  environmentId: null,
  projectId: null,
  operationId: "preparation",
};

describe("workflow VM placement boundaries", () => {
  it("keeps private API records assigned and distinguishes workflow preparation", () => {
    const decode = Schema.decodeUnknownSync(RelayThreadPlacement);
    const personal = decode(privatePlacement);
    expect(isPrivateThreadPlacement(personal)).toBe(true);
    expect(isAssignedThreadPlacement(personal)).toBe(true);
    const preparing = decode(preparation);
    expect(isPrivateThreadPlacement(preparing)).toBe(false);
    expect(isAssignedThreadPlacement(preparing)).toBe(false);
    const assigned = decode({ ...preparation, environmentId: "vm", projectId: "vm-project" });
    expect(isAssignedThreadPlacement(assigned)).toBe(true);
    expect(isPrivateThreadPlacement(assigned)).toBe(false);
  });

  it("rejects mixed locations, private unassigned records and ownerless records without a job", () => {
    const valid = Schema.is(RelayThreadPlacement);
    for (const record of [
      { ...preparation, projectId: "project" },
      { ...preparation, environmentId: "vm" },
      { ...preparation, operationId: null },
      { ...preparation, generation: 2 },
      { ...preparation, workflowJobId: null },
      { ...preparation, ownerUserId: "person" },
      { ...privatePlacement, audience: "private", environmentId: null },
      { ...privatePlacement, audience: "private", workflowJobId: "job" },
      { ...privatePlacement, ownerUserId: null },
    ])
      expect(valid(record)).toBe(false);
  });
});

it("validates zero and PostgreSQL-bounded whole organization limits", () => {
  const policy = {
    organizationId: "organization",
    revision: 1,
    maxRunningVms: DEFAULT_WORKFLOW_VM_LIMIT,
  };
  const valid = Schema.is(WorkflowVmPolicyRecord);
  expect(valid(policy)).toBe(true);
  expect(valid({ ...policy, maxRunningVms: 0 })).toBe(true);
  expect(valid({ ...policy, maxRunningVms: 2_147_483_647 })).toBe(true);
  for (const maxRunningVms of [-1, 0.5, 2_147_483_648, Number.NaN])
    expect(valid({ ...policy, maxRunningVms })).toBe(false);
});
