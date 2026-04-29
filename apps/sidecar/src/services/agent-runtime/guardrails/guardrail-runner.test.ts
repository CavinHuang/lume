import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { builtinToolInputGuardrails } from "./builtin-tool-guardrails";
import { LumeGuardrailRunner } from "./guardrail-runner";

describe("guardrail-runner", () => {
  test("runs builtin tool input guardrails for dangerous bash commands", async () => {
    const runner = new LumeGuardrailRunner(builtinToolInputGuardrails);

    const result = await runner.runToolInputGuardrails({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      context: {
        threadId: "thread-1"
      }
    });

    expect(result).toEqual({
      behavior: "reject",
      reason: "禁止删除根目录"
    });
  });

  test("rejects file writes outside the runtime cwd", async () => {
    const runner = new LumeGuardrailRunner(builtinToolInputGuardrails);
    const cwd = "/tmp/lume-workspace";

    const result = await runner.runToolInputGuardrails({
      toolName: "Write",
      input: { file_path: "/tmp/outside-workspace/secrets.txt", content: "hello" },
      context: {
        threadId: "thread-1",
        cwd
      }
    });

    expect(result).toEqual({
      behavior: "reject",
      reason: "禁止写入 workspace 外路径"
    });
  });

  test("allows file writes inside the runtime cwd", async () => {
    const runner = new LumeGuardrailRunner(builtinToolInputGuardrails);
    const cwd = "/tmp/lume-workspace";

    const result = await runner.runToolInputGuardrails({
      toolName: "Write",
      input: { file_path: join(cwd, "notes.txt"), content: "hello" },
      context: {
        threadId: "thread-1",
        cwd
      }
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  test("requires approval before writing obvious secrets to memory", async () => {
    const runner = new LumeGuardrailRunner(builtinToolInputGuardrails);

    const result = await runner.runToolInputGuardrails({
      toolName: "memory.remember",
      input: { content: "OPENAI_API_KEY=sk-test-secret" },
      context: {
        threadId: "thread-1"
      }
    });

    expect(result).toEqual({
      behavior: "require_approval",
      reason: "记忆写入疑似包含密钥或 token，需要用户确认"
    });
  });
});
