import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smartAddMemoryV2Candidate } from "./smart-add";
import { buildMemoryV2UserMessageContext, buildMemoryUserMessagePrefix, stripMemoryUserMessagePrefix } from "./user-message-prefix";
import type { MemoryV2RecallItem } from "./types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-prefix-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

const recallItem: MemoryV2RecallItem = {
  id: "mem_1",
  kind: "preference",
  scope: "global",
  status: "active",
  statement: "User prefers Chinese communication.",
  path: "/tmp/memory/entries/mem_1.md",
  citation: "/tmp/memory/entries/mem_1.md",
  reason: "matched memory entry",
  score: 10
};

describe("memory-v2 user message prefix", () => {
  test("builds an Alice-style hidden memory context", () => {
    const prefix = buildMemoryUserMessagePrefix([recallItem]);
    expect(prefix).toContain("<lume_memory_context>");
    expect(prefix).toContain("<global_preferences>");
    expect(prefix).toContain("[mem_1] preference: User prefers Chinese communication.");
  });

  test("treats repeated daily questions as continuity, not identity facts", () => {
    const prefix = buildMemoryUserMessagePrefix([{
      ...recallItem,
      id: "workspace:daily:2026-05-20",
      kind: "state",
      scope: "workspace",
      statement: "# 2026-05-20\n\n## Run completed\n\n我是谁？",
      reason: "recent daily memory"
    }]);

    expect(prefix).toContain("If a recalled daily/run note only shows the user asked the same question before");
    expect(prefix).toContain("say naturally that you have discussed or tested this topic before");
    expect(prefix).toContain("For identity-style questions");
    expect(prefix).toContain("没有一个真正能叫出你的称呼");
    expect(prefix).toContain("Do not turn missing identity memory into profile-system wording");
    expect(prefix).toContain("目前我这边还没有记录你的身份信息");
    expect(prefix).toContain("Do not infer identity from runtime metadata");
    expect(prefix).toContain("Do not say phrases like");
    expect(prefix).toContain("从记忆中可以看出");
  });

  test("strips injected prefix and returns visible user text", () => {
    const prefix = buildMemoryUserMessagePrefix([recallItem]);
    const visible = stripMemoryUserMessagePrefix(`${prefix}\n<user_message>\n开始执行\n</user_message>`);
    expect(visible).toBe("开始执行");
  });

  test("injects preferred-name memory for Chinese name questions", async () => {
    smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "User wants to be called Mason.",
        confidence: "high",
        tags: ["preferred-name"]
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "我叫什么名字？"
    });

    expect(context.items[0]).toMatchObject({
      kind: "preference",
      scope: "global",
      statement: "User wants to be called Mason."
    });
    expect(context.userMessageForModel).toContain("User wants to be called Mason.");
  });
});
