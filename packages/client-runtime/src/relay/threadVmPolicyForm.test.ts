import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_THREAD_VM_POLICY } from "@t3tools/contracts/relay";
import {
  parseThreadVmPolicyDraft,
  threadVmPolicyDraft,
  parseWorkflowVmLimit,
} from "./threadVmPolicyForm.ts";

describe("VM policy form input", () => {
  it("accepts a disabled quota and a valid installation time zone", () => {
    const draft = {
      ...threadVmPolicyDraft(DEFAULT_THREAD_VM_POLICY),
      maxVmsPerUser: "0",
      deleteAfterIdleWeekdays: " 1 ",
      calendarTimeZone: " Europe/Berlin ",
    };
    expect(parseThreadVmPolicyDraft(draft)).toEqual({
      ...DEFAULT_THREAD_VM_POLICY,
      maxVmsPerUser: 0,
      deleteAfterIdleWeekdays: 1,
      calendarTimeZone: "Europe/Berlin",
    });
  });

  it.each(["", "2.5", "2days", "-1", "0x10", "1e3", "Infinity"])(
    "refuses ambiguous duration input %j",
    (value) => {
      expect(() =>
        parseThreadVmPolicyDraft({
          ...threadVmPolicyDraft(DEFAULT_THREAD_VM_POLICY),
          deleteAfterIdleWeekdays: value,
        }),
      ).toThrow();
    },
  );

  it("refuses zero durations and unknown time zones", () => {
    const draft = threadVmPolicyDraft(DEFAULT_THREAD_VM_POLICY);
    expect(() => parseThreadVmPolicyDraft({ ...draft, pauseAfterIdleMinutes: "0" })).toThrow();
    expect(() =>
      parseThreadVmPolicyDraft({ ...draft, calendarTimeZone: "Mars/Olympus" }),
    ).toThrow();
  });
});

describe("workflow VM limit input", () => {
  it("accepts zero and the database integer range without changing personal policy", () => {
    expect(parseWorkflowVmLimit(" 0 ")).toBe(0);
    expect(parseWorkflowVmLimit("10")).toBe(10);
    expect(parseWorkflowVmLimit("2147483647")).toBe(2147483647);
    expect(parseThreadVmPolicyDraft(threadVmPolicyDraft(DEFAULT_THREAD_VM_POLICY))).toEqual(
      DEFAULT_THREAD_VM_POLICY,
    );
  });
  it.each(["", " ", "-1", "2.5", "1e3", "0x10", "10 VMs", "2147483648", "Infinity"])(
    "rejects invalid limit %j",
    (value) => {
      expect(() => parseWorkflowVmLimit(value)).toThrow();
    },
  );
});
