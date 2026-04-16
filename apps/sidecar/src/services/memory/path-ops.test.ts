import { describe, expect, test } from "bun:test";
import { ensureInsideRoot, ensurePathAllowed } from "./memory-path-utils";

describe("path-ops", () => {
  test("ensureInsideRoot 允许工作区内路径并拒绝越界", () => {
    const root = "/tmp/lume-workspace";
    expect(ensureInsideRoot(root, "/tmp/lume-workspace/memory/a.md")).toContain("/tmp/lume-workspace");
    expect(() => ensureInsideRoot(root, "/tmp/other/a.md")).toThrow("目标路径超出工作区允许范围");
  });

  test("ensurePathAllowed 允许 workspace 与 extra roots", () => {
    expect(() =>
      ensurePathAllowed({
        workspaceRoot: "/tmp/ws",
        absPath: "/tmp/ws/memory/a.md",
        extraRoots: ["/tmp/ext"]
      })
    ).not.toThrow();

    expect(() =>
      ensurePathAllowed({
        workspaceRoot: "/tmp/ws",
        absPath: "/tmp/ext/a.md",
        extraRoots: ["/tmp/ext"]
      })
    ).not.toThrow();

    expect(() =>
      ensurePathAllowed({
        workspaceRoot: "/tmp/ws",
        absPath: "/tmp/other/a.md",
        extraRoots: ["/tmp/ext"]
      })
    ).toThrow("目标路径超出允许范围");
  });
});
