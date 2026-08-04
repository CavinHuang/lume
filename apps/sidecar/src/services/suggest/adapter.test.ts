import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createAgentThread,
  replaceAgentThreadTranscript,
} from "../agent/agent-thread-manager";
import { extractRecentConversation } from "./adapter";
import type { AgentMessage } from "@lume/shared";

let root: string;
let threadSeq = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-suggest-adapter-"));
  process.env.LUME_CONFIG_DIR = root;
  threadSeq = 0;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

const uid = (): string => `m-${threadSeq++}-${Math.random().toString(36).slice(2, 8)}`;

const um = (content: string): AgentMessage => ({
  id: uid(),
  role: "user",
  content,
  createdAt: Date.now(),
});

const am = (content: string): AgentMessage => ({
  id: uid(),
  role: "assistant",
  content,
  createdAt: Date.now(),
});

describe("extractRecentConversation — brief 契约", () => {
  test("空线程 → []", async () => {
    const t = createAgentThread();
    const out = await extractRecentConversation({ threadId: t.id });
    expect(out).toEqual([]);
  });

  test("仅保留 user 角色（跳过 assistant）", async () => {
    const t = createAgentThread();
    replaceAgentThreadTranscript(t.id, [
      um("你好"),
      am("你好！有什么可以帮你的吗？"),
      um("帮我写代码"),
    ]);
    const out = await extractRecentConversation({ threadId: t.id });
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.role === "user")).toBe(true);
    expect(out.map((m) => m.content)).toEqual(["你好", "帮我写代码"]);
  });

  test("默认 limit=30：超过部分截尾", async () => {
    const t = createAgentThread();
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 35; i++) msgs.push(um(`msg-${i}`));
    replaceAgentThreadTranscript(t.id, msgs);
    const out = await extractRecentConversation({ threadId: t.id });
    expect(out).toHaveLength(30);
    expect(out[0]!.content).toBe("msg-5");
    expect(out[29]!.content).toBe("msg-34");
  });

  test("自定义 limit 生效", async () => {
    const t = createAgentThread();
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) msgs.push(um(`u${i}`));
    replaceAgentThreadTranscript(t.id, msgs);
    const out = await extractRecentConversation({ threadId: t.id, limit: 3 });
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.content)).toEqual(["u7", "u8", "u9"]);
  });

  test("单条 content 切片至 800 字符", async () => {
    const t = createAgentThread();
    const long = "x".repeat(1200);
    replaceAgentThreadTranscript(t.id, [um(long)]);
    const out = await extractRecentConversation({ threadId: t.id });
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toHaveLength(800);
  });

  test("跳过空 / 全空白 user 消息", async () => {
    const t = createAgentThread();
    replaceAgentThreadTranscript(t.id, [
      um("hello"),
      um("   "),
      um(""),
      um("\n\t"),
      um("world"),
    ]);
    const out = await extractRecentConversation({ threadId: t.id });
    expect(out.map((m) => m.content)).toEqual(["hello", "world"]);
  });

  test("fail-open：不存在的线程 → []（不抛错）", async () => {
    const out = await extractRecentConversation({ threadId: "non-existent-thread-id" });
    expect(out).toEqual([]);
  });

  test("fail-open：空 / 纯空白 threadId → []", async () => {
    expect(await extractRecentConversation({ threadId: "" })).toEqual([]);
    expect(await extractRecentConversation({ threadId: "   " })).toEqual([]);
  });

  test("输出形状：{role:'user'; content:string}[] 与 signals.UserMessage 一致", async () => {
    const t = createAgentThread();
    replaceAgentThreadTranscript(t.id, [um("abc")]);
    const out = await extractRecentConversation({ threadId: t.id });
    expect(out[0]).toEqual({ role: "user", content: "abc" });
  });
});
