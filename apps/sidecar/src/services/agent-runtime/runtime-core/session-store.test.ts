import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrResumeRuntimeCoreSessionManager } from "./session-store";

function setup() {
  const agentDir = mkdtempSync(join(tmpdir(), "lume-session-store-agentdir-"));
  const cwd = mkdtempSync(join(tmpdir(), "lume-session-store-cwd-"));
  const manager = createOrResumeRuntimeCoreSessionManager(cwd, "session-store-test", agentDir);
  return { agentDir, cwd, manager };
}

function readJsonl(sessionDir: string): string {
  return readFileSync(join(sessionDir, "transcript.jsonl"), "utf-8");
}

function parseJsonlLines(raw: string): unknown[] {
  // 复刻 SDK loadSession 的逐行严格解析（trim + 过滤空行）
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

describe("session-store appendMessage/appendMessages", () => {
  test("单条 append 追加一行，且对无尾换行的既有 jsonl 补分隔", () => {
    const { agentDir, cwd, manager } = setup();
    try {
      // 先批量写入两条（无尾换行格式），再走单条 append 路径
      manager.appendMessages([
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] }
      ]);
      const before = readJsonl(manager.getSessionDir());
      expect(before.endsWith("\n")).toBe(false);
      expect(parseJsonlLines(before)).toHaveLength(2);

      manager.appendMessage({ role: "user", content: "again" });
      const after = parseJsonlLines(readJsonl(manager.getSessionDir()));
      expect(after).toHaveLength(3);
      expect((after[2] as { content: unknown }).content).toBe("again");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("appendMessages 批量与逐条 appendMessage 终态等价", () => {
    const a = setup();
    const b = setup();
    try {
      const messages = [
        { role: "user" as const, content: "q1", timestamp: 1_000 },
        { role: "assistant" as const, content: [{ type: "text", text: "a1" }], provider: "anthropic", model: "m1", timestamp: 2_000 },
        { role: "user" as const, content: "q2", timestamp: 3_000 }
      ];
      a.manager.appendMessages(messages);
      for (const message of messages) b.manager.appendMessage(message);

      const stripUuid = (lines: unknown[]) => lines.map((line) => {
        const { uuid: _uuid, ...rest } = line as { uuid: string };
        return rest;
      });
      const linesA = stripUuid(parseJsonlLines(readJsonl(a.manager.getSessionDir())));
      const linesB = stripUuid(parseJsonlLines(readJsonl(b.manager.getSessionDir())));
      expect(linesA).toEqual(linesB);
      expect(linesA).toHaveLength(3);
    } finally {
      for (const dir of [a.agentDir, b.agentDir, a.cwd, b.cwd]) rmSync(dir, { recursive: true, force: true });
    }
  });

  // #527 三审①收官（jsonl 状态源）：撕裂尾行使快路径失效，
  // 追加时全量重建 jsonl，完好前缀无损、撕裂内容被丢弃
  test("撕裂尾行 append 时全量重建且完好消息无损", () => {
    const { agentDir, cwd, manager } = setup();
    try {
      manager.appendMessages([
        { role: "user", content: "one" },
        { role: "user", content: "two" }
      ]);
      // 模拟崩溃撕裂：最后一行变半截 JSON
      const sessionDir = manager.getSessionDir();
      const rawLines = readJsonl(sessionDir).split("\n").filter(Boolean);
      writeFileSync(
        join(sessionDir, "transcript.jsonl"),
        `${rawLines[0]}\n{"uuid":"torn`,
        "utf-8"
      );

      manager.appendMessage({ role: "user", content: "three" });
      const lines = parseJsonlLines(readJsonl(sessionDir));
      expect(lines).toHaveLength(2);
      expect((lines[0] as { content: unknown }).content).toBe("one");
      expect((lines[1] as { content: unknown }).content).toBe("three");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // #527 三审①收官（缓存）：连续单条快路径下 tail 计数不得漂移丢行
  test("连续多次单条 append 全部落盘且元数据计数一致", () => {
    const { agentDir, cwd, manager } = setup();
    try {
      for (let i = 0; i < 6; i += 1) {
        manager.appendMessage({ role: "user", content: `m${i}` });
      }
      const lines = parseJsonlLines(readJsonl(manager.getSessionDir()));
      expect(lines).toHaveLength(6);
      const stored = JSON.parse(
        readFileSync(join(manager.getSessionDir(), "transcript.json"), "utf-8")
      ) as { metadata?: { messageCount?: number } };
      expect(stored.metadata?.messageCount).toBe(6);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // #527 三审①收官（缓存）：外部改写 transcript.json 后追加须冷读保留外部改动
  test("外部修改 json 元数据后 append 不回冲", () => {
    const { agentDir, cwd, manager } = setup();
    try {
      manager.appendMessage({ role: "user", content: "first" });
      const sessionDir = manager.getSessionDir();
      const raw = readFileSync(join(sessionDir, "transcript.json"), "utf-8");
      const mutated = (JSON.parse(raw) as Record<string, unknown>);
      const metadata = mutated.metadata as Record<string, unknown>;
      metadata.tag = "external-tag";
      writeFileSync(join(sessionDir, "transcript.json"), JSON.stringify(mutated), "utf-8");

      manager.appendMessage({ role: "user", content: "second" });
      const after = JSON.parse(
        readFileSync(join(sessionDir, "transcript.json"), "utf-8")
      ) as { metadata?: { tag?: string } };
      // 快照失效→冷读→外部 tag 进入后续写入的基线
      expect(after.metadata?.tag).toBe("external-tag");
      expect(parseJsonlLines(readJsonl(sessionDir))).toHaveLength(2);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // #527 三审①收官（升级）：旧肥 json（内嵌数组）+ 缺失 jsonl 冷启动时，
  // 首次写入必须把内嵌数组升级进 jsonl 并保持权威一致
  test("旧格式会话首次 append 升级 jsonl 状态源", () => {
    const { agentDir, cwd, manager } = setup();
    try {
      manager.appendMessage({ role: "user", content: "legacy-one" });
      // 模拟旧世界：删除 jsonl，历史只存在于 fat json
      rmSync(join(manager.getSessionDir(), "transcript.jsonl"));
      // 重新放回一条伪造的旧 fat json（含 sessionMessages 内嵌）
      const legacy = {
        metadata: {
          id: "session-store-test",
          cwd,
          model: "unknown/unknown",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 1
        },
        messages: [{ role: "user", content: "legacy-one" }],
        sessionMessages: [
          {
            uuid: "legacy-uuid",
            role: "user",
            timestamp: new Date().toISOString(),
            content: "legacy-one"
          }
        ]
      };
      writeFileSync(
        join(manager.getSessionDir(), "transcript.json"),
        JSON.stringify(legacy),
        "utf-8"
      );

      manager.appendMessage({ role: "user", content: "fresh-two" });
      const lines = parseJsonlLines(readJsonl(manager.getSessionDir())) as Array<{ uuid: string; content?: unknown }>;
      expect(lines).toHaveLength(2);
      expect(lines[0]?.content).toBe("legacy-one"); // 内嵌历史升级进 jsonl
      expect(lines[1]?.content).toBe("fresh-two");
      expect(lines[0]?.uuid).toBe("legacy-uuid"); // uuid 权威随源保留
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
