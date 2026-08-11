import { describe, expect, test } from "bun:test";
import { computeColumnCount, rowCount, PROVIDER_GRID } from "./provider-grid";

describe("computeColumnCount", () => {
  test("非正宽度回退 1 列", () => {
    expect(computeColumnCount(0)).toBe(1);
    expect(computeColumnCount(-5)).toBe(1);
  });
  test("按 minCardWidth 取下整", () => {
    const min = PROVIDER_GRID.minCardWidth;
    expect(computeColumnCount(min - 1)).toBe(1);
    expect(computeColumnCount(min)).toBe(1);
    expect(computeColumnCount(min * 2)).toBe(1);
    expect(computeColumnCount(min * 2 + PROVIDER_GRID.gap)).toBe(2);
    expect(computeColumnCount(min * 3 + PROVIDER_GRID.gap * 2)).toBe(3);
  });
  test("自定义 minCardWidth 生效", () => {
    expect(computeColumnCount(324, 100)).toBe(3);
  });
});

describe("rowCount", () => {
  test("按列数上整", () => {
    expect(rowCount(0, 3)).toBe(0);
    expect(rowCount(1, 3)).toBe(1);
    expect(rowCount(3, 3)).toBe(1);
    expect(rowCount(4, 3)).toBe(2);
    expect(rowCount(6, 3)).toBe(2);
  });
  test("列数 ≤0 视为 0 行", () => {
    expect(rowCount(10, 0)).toBe(0);
  });
});
