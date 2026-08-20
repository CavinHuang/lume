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

  test("jsonl 行数与 json 脱节时单条 append 退回全量重写", () => {
    const { agentDir, cwd, manager } = setup();
    try {
      manager.appendMessages([
        { role: "user", content: "one" },
        { role: "user", content: "two" }
      ]);
      // 模拟崩溃截断：丢掉最后一行（保留无尾换行格式）
      const sessionDir = manager.getSessionDir();
      const raw = readJsonl(sessionDir);
      const truncated = raw.split("\n").slice(0, 1).join("\n");
      writeFileSync(join(sessionDir, "transcript.jsonl"), truncated, "utf-8");

      manager.appendMessage({ role: "user", content: "three" });
      const lines = parseJsonlLines(readJsonl(sessionDir));
      expect(lines).toHaveLength(3);
      expect((lines[2] as { content: unknown }).content).toBe("three");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
