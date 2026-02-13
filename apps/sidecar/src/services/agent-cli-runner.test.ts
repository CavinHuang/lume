import { describe, expect, test } from "bun:test";
import { __internal } from "./agent-cli-runner";

describe("agent-cli-runner", () => {
  test("应生成 codex resume 的进程匹配模式", () => {
    const matchers = __internal.buildSessionMatchersForBackend("codex_cli");
    expect(matchers.length).toBeGreaterThan(0);
    const cmd = "codex exec resume thread-99 --color never --sandbox read-only --skip-git-repo-check";
    expect(matchers.some((matcher) => matcher.test(cmd))).toBe(true);
  });

  test("应生成 claude sessionArg 的进程匹配模式", () => {
    const matchers = __internal.buildSessionMatchersForBackend("claude_cli");
    expect(matchers.length).toBeGreaterThan(0);
    const cmd = "claude --session-id abc123";
    expect(matchers.some((matcher) => matcher.test(cmd))).toBe(true);
  });

  test("应从 ps 输出中提取挂起且匹配的 pid", () => {
    const matchers = __internal.buildSessionMatchersForBackend("codex_cli");
    const psOutput = [
      "  50 T  codex exec resume thread-99 --color never --sandbox read-only --skip-git-repo-check",
      "  51 T  codex exec resume other --color never --sandbox read-only --skip-git-repo-check",
      "  52 S  codex exec resume thread-99 --color never --sandbox read-only --skip-git-repo-check",
      "  53 T  other-binary --foo bar"
    ].join("\n");
    const pids = __internal.collectSuspendedMatchedPids(psOutput, matchers);
    expect(pids).toEqual([50, 51]);
  });

  test("claude_cli JSON 输出应解析 text 与 session id", () => {
    const output = JSON.stringify({
      session_id: "claude-session-1",
      content: [{ type: "text", text: "hello from claude" }],
      usage: { input_tokens: 12, output_tokens: 5 }
    });
    const result = __internal.parseOutputForBackend("claude_cli", output);
    expect(result.text).toBe("hello from claude");
    expect(result.sessionId).toBe("claude-session-1");
    expect(result.usage?.input).toBe(12);
    expect(result.usage?.output).toBe(5);
  });

  test("codex_cli JSONL 输出应解析 thread id 与文本", () => {
    const output = [
      JSON.stringify({ thread_id: "thread-xyz", item: { type: "message", text: "line 1" } }),
      JSON.stringify({ item: { type: "message", text: "line 2" } })
    ].join("\n");
    const result = __internal.parseOutputForBackend("codex_cli", output);
    expect(result.sessionId).toBe("thread-xyz");
    expect(result.text).toBe("line 1\nline 2");
  });
});
