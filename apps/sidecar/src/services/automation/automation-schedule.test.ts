import { describe, expect, test } from "bun:test";
import {
  cronDateFeasible,
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
    // CI 并行跑批下 DST 时区扫描实测可破 5s 默认线(本地 <1.5s),放宽超时避免环境性红。
  }, 20000);

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

describe("cron feasibility AND semantics (#452)", () => {
  test("dom/dow 与 matchCronExpression 同取 AND：二月三十一日且周一永假", () => {
    // 修复前 cronDateFeasible 假设 dom/dow 取 OR，dow 受限直接放行——
    // `0 9 31 2 1` 判 feasible=true 但实际永不命中
    expect(cronDateFeasible("0 9 31 2 1")).toBeFalse();
    expect(cronDateFeasible("0 9 31 2 *")).toBeFalse();
    expect(cronDateFeasible("0 9 30 2 1")).toBeFalse();
  });

  test("dom/month 可命中的组合不受 dow 影响（AND 下 dow 无法致永假）", () => {
    expect(cronDateFeasible("0 9 15 2 1")).toBeTrue();
    expect(cronDateFeasible("0 9 15 2 *")).toBeTrue();
    expect(cronDateFeasible("0 9 * 2 1")).toBeTrue();
    expect(cronDateFeasible("0 9 * * *")).toBeTrue();
    expect(cronDateFeasible("0 9 29 2 *")).toBeTrue(); // 闰年保守放行 2/29
  });

  test("validate 拒绝创建，getNextAutomationRunAt 返回 null 而非抛", () => {
    const infeasible = { type: "cron", cronExpr: "0 9 31 2 *" } as const;
    expect(() => validateAutomationSchedule(infeasible)).toThrow("永不可能命中");
    expect(getNextAutomationRunAt(infeasible)).toBeNull();

    // 存量脏数据同样跳过调度而非抛：无效时区 / schedule 缺失
    expect(getNextAutomationRunAt({ type: "cron", cronExpr: "0 9 * * *", timezone: "Mars/Olympus" })).toBeNull();
    expect(getNextAutomationRunAt(undefined as never)).toBeNull();

    // 合法 schedule 行为不变
    const from = Date.parse("2026-07-28T00:00:00.000Z");
    expect(getNextCronRunAt("30 9 * * *", from, "UTC")).toBe(Date.parse("2026-07-28T09:30:00.000Z"));
  });
});
