import { afterEach, describe, expect, test } from "bun:test";
import { localDateKey } from "./routine-date";

/**
 * #451：日程语义一律按本地日历日。bun test 进程固定按 UTC 跑，
 * 这里显式切换到带偏移的时区钉死「本地键 ≠ UTC 键」的行为。
 */
const oldTz = process.env.TZ;

afterEach(() => {
  // 注意：bun 的时区缓存经不起 delete 后重设，恢复必须走显式赋值
  process.env.TZ = oldTz ?? "UTC";
});

describe("localDateKey", () => {
  test("东十二区（UTC+14）：UTC 23:30 时本地已是次日", () => {
    process.env.TZ = "Pacific/Kiritimati";
    expect(localDateKey(new Date("2026-06-15T23:30:00Z"))).toBe("2026-06-16");
  });

  test("西十一区（UTC-11）：UTC 01:30 时本地仍是前一日", () => {
    process.env.TZ = "Pacific/Pago_Pago";
    expect(localDateKey(new Date("2026-06-15T01:30:00Z"))).toBe("2026-06-14");
  });

  test("月/日补零输出 YYYY-MM-DD", () => {
    process.env.TZ = "Pacific/Kiritimati";
    expect(localDateKey(new Date(2000, 0, 5))).toBe("2000-01-05");
    expect(localDateKey(new Date(2026, 10, 3))).toBe("2026-11-03");
  });
});
