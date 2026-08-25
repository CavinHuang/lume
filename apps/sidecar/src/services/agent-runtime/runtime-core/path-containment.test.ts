import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isPathInside } from "./path-containment";

describe("isPathInside", () => {
  test("root 内路径（含自身）判内部", () => {
    expect(isPathInside("/ws", "/ws/a/b")).toBeTrue();
    expect(isPathInside("/ws", "/ws")).toBeTrue();
  });

  test("root 外与兄弟目录判外部", () => {
    expect(isPathInside("/ws", "/other/a")).toBeFalse();
    expect(isPathInside("/ws", "/ws2")).toBeFalse();
  });

  test('".." 开头的目录名是 root 内合法名字，不构成逃逸', () => {
    // coding-verification 原弱版语义：首段精确比较，"..foo" ≠ ".."
    expect(isPathInside("/ws", join("/ws", "..foo", "package.json"))).toBeTrue();
    expect(isPathInside("/ws", "/ws/..foo")).toBeTrue();
  });

  test("真正的 .. 逃逸判外部", () => {
    expect(isPathInside("/ws", "/ws/../escape")).toBeFalse();
    expect(isPathInside("/ws", "..")).toBeFalse();
  });
});
