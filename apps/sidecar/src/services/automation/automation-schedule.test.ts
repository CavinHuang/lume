import { describe, expect, test } from "bun:test";
import {
  getNextAutomationRunAt,
  getNextCronRunAt,
  matchCronExpression,
  validateAutomationSchedule
} from "./automation-schedule";

describe("automation schedule timezone and misfire primitives", () => {
  test("matches cron in the configured IANA timezone", () => {
    const instant = new Date("2026-07-28T01:30:00.000Z");
    expect(matchCronExpression("30 9 * * *", instant, "Asia/Shanghai")).toBeTrue();
    expect(matchCronExpression("30 9 * * *", instant, "UTC")).toBeFalse();
  });

  test("skips a missing DST minute and does not repeat a duplicated local minute", () => {
    const spring = getNextCronRunAt(
      "30 2 * * *",
      Date.parse("2026-03-08T05:00:00.000Z"),
      "America/New_York"
    );
    expect(spring).toBe(Date.parse("2026-03-09T06:30:00.000Z"));

    const firstFallOccurrence = Date.parse("2026-11-01T05:30:00.000Z");
    const afterFirstOccurrence = getNextCronRunAt(
      "30 1 * * *",
      firstFallOccurrence,
      "America/New_York"
    );
    expect(afterFirstOccurrence).toBe(Date.parse("2026-11-02T06:30:00.000Z"));
  });

  test("keeps interval schedules anchored instead of drifting from completion time", () => {
    const anchor = Date.parse("2026-07-28T00:00:00.000Z");
    expect(getNextAutomationRunAt(
      { type: "interval", intervalMs: 60_000 },
      anchor + 151_000,
      anchor
    )).toBe(anchor + 180_000);
  });

  test("rejects invalid timezones and misfire policies", () => {
    expect(() => validateAutomationSchedule({
      type: "cron",
      cronExpr: "0 9 * * *",
      timezone: "Mars/Olympus"
    })).toThrow("无效的 IANA 时区");
    expect(() => validateAutomationSchedule({
      type: "once",
      runAt: Date.now() + 1_000,
      misfirePolicy: "replay_all" as never
    })).toThrow("misfirePolicy");
  });
});
