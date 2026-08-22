import { describe, expect, test } from "bun:test";
import { buildGrepArgs } from "./grep.js";

describe("buildGrepArgs", () => {
  test("maps -A/-B context flags for the GNU grep fallback", () => {
    const args = buildGrepArgs(
      { pattern: "todo", "-A": 3, "-B": 2 },
      "content",
      "/tmp/project",
    );
    expect(args).toContain("-A");
    expect(args[args.indexOf("-A") + 1]).toBe("3");
    expect(args).toContain("-B");
    expect(args[args.indexOf("-B") + 1]).toBe("2");
    expect(args[args.length - 2]).toBe("todo");
  });

  test("maps -C and its context alias", () => {
    const fromShort = buildGrepArgs({ pattern: "x", "-C": 5 }, "content", "/tmp");
    const fromAlias = buildGrepArgs({ pattern: "x", context: 5 }, "content", "/tmp");
    for (const args of [fromShort, fromAlias]) {
      const index = args.indexOf("-C");
      expect(index).toBeGreaterThanOrEqual(0);
      expect(args[index + 1]).toBe("5");
    }
  });

  test("omits context flags when not requested", () => {
    const args = buildGrepArgs({ pattern: "x" }, "files_with_matches", "/tmp");
    expect(args).not.toContain("-A");
    expect(args).not.toContain("-B");
    expect(args).not.toContain("-C");
  });
});
