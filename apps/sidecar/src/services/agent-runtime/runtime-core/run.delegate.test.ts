import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentThread,
  listAgentThreads
} from "../../agent/agent-thread-manager";
import { getSubagentRunRegistry } from "../../agent/subagents/subagent-run-registry";
import { canDelegateFromThread, deriveDelegateTitle } from "./run";

describe("DelegateTool child thread", () => {
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-delegate-"));
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
  });

  test("createAgentThread 携带 parentThreadId，子会话进入 listAgentThreads", () => {
    const parent = createAgentThread("父会话", undefined, "ws-1");
    const child = createAgentThread("子会话", undefined, "ws-1", parent.id);
    expect(child.parentThreadId).toBe(parent.id);
    const listed = listAgentThreads();
    expect(listed.find((t) => t.id === child.id)).toBeDefined();
    expect(listed.find((t) => t.id === child.id)?.parentThreadId).toBe(parent.id);
  });
});

describe("DelegateTool depth guard (D7)", () => {
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-delegate-depth-"));
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
  });

  test("顶层 thread 允许 delegate", () => {
    const parent = createAgentThread("父", undefined, "ws-1");
    expect(canDelegateFromThread(parent.id).ok).toBe(true);
  });

  test("已是子会话的 thread 禁止再 delegate", () => {
    const root = createAgentThread("root", undefined, "ws-1");
    const child = createAgentThread("child", undefined, "ws-1", root.id);
    // 模拟 child 是一个 subagent run 的 childThreadId
    getSubagentRunRegistry().create({
      runId: "run-1", parentThreadId: root.id, rootThreadId: root.id,
      depth: 1, childThreadId: child.id, task: "t", cleanup: "keep", status: "running"
    });
    expect(canDelegateFromThread(child.id).ok).toBe(false);
  });

  test("父 thread 有 parentThreadId 元数据（无 registry 记录）也禁止 delegate", () => {
    const root = createAgentThread("root", undefined, "ws-1");
    const child = createAgentThread("child", undefined, "ws-1", root.id); // child.parentThreadId = root.id
    // 注意：不创建 registry 记录，仅靠 meta.parentThreadId 拦截
    expect(canDelegateFromThread(child.id).ok).toBe(false);
  });
});

describe("DelegateTool title fallback", () => {
  test("输出非空时用输出摘要作为标题（取前 20 字）", () => {
    // 输入超过 20 字，验证截断为前 20 字
    expect(deriveDelegateTitle(undefined, "这是一段超过二十个字符的子会话输出结果内容示例")).toBe("这是一段超过二十个字符的子会话输出结果内");
  });

  test("输出短于 20 字时原样作为标题", () => {
    expect(deriveDelegateTitle(undefined, "短输出")).toBe("短输出");
  });

  test("输出为空时保留原标题", () => {
    expect(deriveDelegateTitle("原标题", undefined)).toBe("原标题");
  });

  test("输出仅含空白时保留原标题", () => {
    expect(deriveDelegateTitle("原标题", "   \n\t  ")).toBe("原标题");
  });

  test("折叠输出中的多余空白后再截断", () => {
    expect(deriveDelegateTitle("原标题", "hello    world\nnext")).toBe("hello world next".slice(0, 20));
  });
});
