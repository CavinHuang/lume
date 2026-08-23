import { describe, expect, test } from "bun:test";
import { buildGrepArgs, buildNativeSearchOptions, EXCLUDED_DIRS } from "./grep.js";

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

describe("buildNativeSearchOptions", () => {
  test("passes hidden:false and gitignore:true to the native engine (#337)", () => {
    // native 引擎 Rust 侧 hidden 默认 true,会把 .git/HEAD、packed-refs 当
    // 普通文件命中;必须与 rg 回退同口径显式关掉。
    const options = buildNativeSearchOptions({ pattern: "todo" }, "/tmp/project", "files_with_matches", 0, 250);
    expect(options.hidden).toBe(false);
    expect(options.gitignore).toBe(true);
    expect(options.pattern).toBe("todo");
    expect(options.path).toBe("/tmp/project");
  });

  test("keeps the fallback exclusion list covered by the hidden:false semantics", () => {
    // native 通道没有独立 exclude 参数:rg/grep 回退显式排除的目录全部是
    // 点前缀,hidden:false(跳过隐藏目录)即同等口径。若未来往清单加入非
    // 隐藏目录,此不变量失败即为提醒——native 层需要真正的排除机制。
    expect(EXCLUDED_DIRS).toContain(".git");
    expect(EXCLUDED_DIRS.every((directory) => directory.startsWith("."))).toBeTrue();
  });

  test("preserves pagination and mode fields", () => {
    const options = buildNativeSearchOptions({ pattern: "x", "-A": 2, "-B": 1 }, "/tmp", "count", 10, 50);
    expect(options.mode).toBe("count");
    expect(options.offset).toBe(10);
    expect(options.max_count).toBe(50);
    expect(options.context_after).toBe(2);
    expect(options.context_before).toBe(1);
  });
});
