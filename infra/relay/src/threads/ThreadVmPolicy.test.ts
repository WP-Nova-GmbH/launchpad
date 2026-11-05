import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_THREAD_VM_POLICY, ThreadVmPolicy } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { addWeekdayTime, idleDeadlines, savedDiskExpiresAt } from "./ThreadVmPolicy.ts";

describe("thread VM inactivity policy", () => {
  it("counts two full weekdays rather than two shifts", () => {
    expect(addWeekdayTime(DateTime.makeUnsafe("2026-10-01T15:30:00Z"), 2, "UTC")).toBe(
      "2026-10-05T15:30:00.000Z",
    );
    expect(addWeekdayTime(DateTime.makeUnsafe("2026-10-05T15:30:00Z"), 2, "UTC")).toBe(
      "2026-10-07T15:30:00.000Z",
    );
  });
  it("does not count a weekend start and preserves an exact midnight deadline", () => {
    expect(addWeekdayTime(DateTime.makeUnsafe("2026-10-03T12:00:00Z"), 2, "UTC")).toBe(
      "2026-10-07T00:00:00.000Z",
    );
    expect(addWeekdayTime(DateTime.makeUnsafe("2026-10-02T00:00:00Z"), 1, "UTC")).toBe(
      "2026-10-03T00:00:00.000Z",
    );
  });
  it("uses the configured calendar across daylight-saving weekends", () => {
    expect(addWeekdayTime(DateTime.makeUnsafe("2026-10-23T14:00:00Z"), 2, "Europe/Berlin")).toBe(
      "2026-10-27T15:00:00.000Z",
    );
    expect(addWeekdayTime(DateTime.makeUnsafe("2026-03-27T15:00:00Z"), 2, "Europe/Berlin")).toBe(
      "2026-03-31T14:00:00.000Z",
    );
  });
  it("holds deadlines for busy or unknown activity and recalculates policy edits", () => {
    const idleSince = DateTime.makeUnsafe("2026-10-02T12:00:00Z");
    for (const activity of ["busy", "unknown"] as const)
      expect(idleDeadlines({ idleSince, activity, policy: DEFAULT_THREAD_VM_POLICY })).toBeNull();
    expect(
      idleDeadlines({ idleSince: null, activity: "idle", policy: DEFAULT_THREAD_VM_POLICY }),
    ).toBeNull();
    expect(
      idleDeadlines({ idleSince, activity: "idle", policy: DEFAULT_THREAD_VM_POLICY }),
    ).toEqual({ pauseAt: "2026-10-02T12:30:00.000Z", deleteAt: "2026-10-06T12:00:00.000Z" });
    expect(
      idleDeadlines({
        idleSince,
        activity: "idle",
        policy: {
          ...DEFAULT_THREAD_VM_POLICY,
          pauseAfterIdleMinutes: 10,
          deleteAfterIdleWeekdays: 1,
        },
      }),
    ).toEqual({ pauseAt: "2026-10-02T12:10:00.000Z", deleteAt: "2026-10-05T12:00:00.000Z" });
  });
  it("retains saved disks for calendar days, including weekends", () => {
    expect(
      savedDiskExpiresAt(DateTime.makeUnsafe("2026-10-02T12:00:00Z"), DEFAULT_THREAD_VM_POLICY),
    ).toBe("2026-11-01T12:00:00.000Z");
    expect(
      savedDiskExpiresAt(DateTime.makeUnsafe("2026-10-02T12:00:00Z"), {
        ...DEFAULT_THREAD_VM_POLICY,
        calendarTimeZone: "Europe/Berlin",
      }),
    ).toBe("2026-11-01T13:00:00.000Z");
  });
  it("rejects invalid timezones, negative quota and disabled inactivity thresholds", () => {
    const valid = Schema.is(ThreadVmPolicy);
    expect(valid({ ...DEFAULT_THREAD_VM_POLICY, maxVmsPerUser: 0 })).toBe(true);
    expect(valid({ ...DEFAULT_THREAD_VM_POLICY, maxVmsPerUser: -1 })).toBe(false);
    expect(valid({ ...DEFAULT_THREAD_VM_POLICY, calendarTimeZone: "not-a-zone" })).toBe(false);
    expect(valid({ ...DEFAULT_THREAD_VM_POLICY, pauseAfterIdleMinutes: 0 })).toBe(false);
  });
});
