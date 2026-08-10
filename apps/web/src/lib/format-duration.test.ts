import { describe, expect, test } from "bun:test";
import { formatDurationLabel } from "./format-duration";

describe("formatDurationLabel", () => {
  test("<60s 保留 1 位小数", () => {
    expect(formatDurationLabel(0)).toBe("0.0s");
    expect(formatDurationLabel(1200)).toBe("1.2s");
    expect(formatDurationLabel(59999)).toBe("60.0s");
  });
  test("60s..1h 为 mm:ss", () => {
    expect(formatDurationLabel(60000)).toBe("1:00");
    expect(formatDurationLabel(125000)).toBe("2:05");
  });
  test(">=1h 为 h:mm:ss", () => {
    expect(formatDurationLabel(3600000)).toBe("1:00:00");
    expect(formatDurationLabel(3723000)).toBe("1:02:03");
  });
});
