import { describe, expect, test } from "bun:test";
import { parseAgentRuntimeConfigPayload } from "./agent-runtime-config";

describe("agent-runtime-config", () => {
  test("应解析 cliBackends 覆盖配置", () => {
    const result = parseAgentRuntimeConfigPayload({
      version: 1,
      cliBackends: {
        claude_cli: {
          command: "claude-custom",
          args: ["-p", "--output-format", "json"],
          output: "json",
          env: { FOO: "bar" },
          clearEnv: ["ANTHROPIC_API_KEY"],
          serialize: false
        },
        codex_cli: {
          command: "codex-custom",
          resumeOutput: "text",
          sessionIdFields: ["thread_id"]
        }
      }
    });

    expect(result.cliBackends.claude_cli?.command).toBe("claude-custom");
    expect(result.cliBackends.claude_cli?.args).toEqual(["-p", "--output-format", "json"]);
    expect(result.cliBackends.claude_cli?.env).toEqual({ FOO: "bar" });
    expect(result.cliBackends.claude_cli?.clearEnv).toEqual(["ANTHROPIC_API_KEY"]);
    expect(result.cliBackends.claude_cli?.serialize).toBe(false);
    expect(result.cliBackends.codex_cli?.command).toBe("codex-custom");
    expect(result.cliBackends.codex_cli?.resumeOutput).toBe("text");
    expect(result.cliBackends.codex_cli?.sessionIdFields).toEqual(["thread_id"]);
  });

  test("非法字段应被忽略", () => {
    const result = parseAgentRuntimeConfigPayload({
      cliBackends: {
        claude_cli: {
          command: 123,
          output: "bad",
          args: [1, 2]
        }
      }
    });

    expect(result.cliBackends.claude_cli?.command).toBeUndefined();
    expect(result.cliBackends.claude_cli?.output).toBeUndefined();
    expect(result.cliBackends.claude_cli?.args).toBeUndefined();
  });

  test("兼容 OpenClaw 风格 key（claude-cli/codex-cli）", () => {
    const result = parseAgentRuntimeConfigPayload({
      cliBackends: {
        "claude-cli": {
          command: "claude-openclaw"
        },
        "codex-cli": {
          command: "codex-openclaw"
        }
      }
    });

    expect(result.cliBackends.claude_cli?.command).toBe("claude-openclaw");
    expect(result.cliBackends.codex_cli?.command).toBe("codex-openclaw");
  });

  test("保留自定义 backend key", () => {
    const result = parseAgentRuntimeConfigPayload({
      cliBackends: {
        "my-custom-cli": {
          command: "mycli",
          args: ["run"]
        }
      }
    });
    expect(result.cliBackends["my-custom-cli"]?.command).toBe("mycli");
    expect(result.cliBackends["my-custom-cli"]?.args).toEqual(["run"]);
  });
});
