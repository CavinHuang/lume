import { describe, expect, test } from "bun:test";
import { BashResultRenderer } from "./bash-result";
import { DefaultResultRenderer } from "./default-result";
import { EditResultRenderer } from "./edit-result";
import { resolveToolResultRenderer } from "./registry";

describe("tool-result-renderer registry", () => {
  test("应大小写无关地解析已注册工具", () => {
    expect(resolveToolResultRenderer("Bash")).toBe(BashResultRenderer);
    expect(resolveToolResultRenderer("bash")).toBe(BashResultRenderer);
    expect(resolveToolResultRenderer("  BASH  ")).toBe(BashResultRenderer);
  });

  test("应将 MultiEdit 映射到 Edit 渲染器", () => {
    expect(resolveToolResultRenderer("MultiEdit")).toBe(EditResultRenderer);
  });

  test("未知工具应回退默认渲染器", () => {
    expect(resolveToolResultRenderer("unknown_tool")).toBe(DefaultResultRenderer);
  });
});

