import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smartAddMemoryV2Candidate } from "./smart-add";
import { buildMemoryV2UserMessageContext, buildMemoryUserMessagePrefix, stripMemoryUserMessagePrefix } from "./user-message-prefix";
import { createMemoryV2Store } from "./markdown-store";
import { writePersona } from "./persona";
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
    expect(prefix).toContain("For user identity questions");
    expect(prefix).toContain("For assistant identity questions");
    expect(prefix).toContain("没有一个真正能叫出你的称呼");
    expect(prefix).toContain("Do not turn missing identity memory into profile-system wording");
    expect(prefix).toContain("目前我这边还没有记录你的身份信息");
    expect(prefix).toContain("Do not infer identity from runtime metadata");
    expect(prefix).toContain("Do not say phrases like");
    expect(prefix).toContain("从记忆中可以看出");
  });

  test("does not promote daily or run state snippets into the profile section", () => {
    const prefix = buildMemoryUserMessagePrefix([{
      ...recallItem,
      id: "mem_profile",
      statement: "用户希望被称呼为 Mason"
    }, {
      ...recallItem,
      id: "workspace:daily:2026-05-20",
      kind: "state",
      scope: "workspace",
      statement: "我叫什么名字？\n叫我 mason",
      reason: "recent daily memory"
    }]);

    const profileSection = prefix.match(/<user_profile>[\s\S]*?<\/user_profile>/)?.[0] ?? "";
    expect(profileSection).toContain("用户希望被称呼为 Mason");
    expect(profileSection).not.toContain("我叫什么名字");
  });

  test("strips injected prefix and returns visible user text", () => {
    const prefix = buildMemoryUserMessagePrefix([recallItem]);
    const visible = stripMemoryUserMessagePrefix(`${prefix}\n<user_message>\n开始执行\n</user_message>`);
    expect(visible).toBe("开始执行");
  });

  test("injects preferred-name memory for Chinese name questions", async () => {
    await smartAddMemoryV2Candidate({
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

  test("injects profile memories before noisy daily recall without duplicates", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "workspace",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"]
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "state",
        targetScope: "workspace",
        statement: "用户之前多次问过：我是谁？",
        confidence: "high",
        tags: ["daily"]
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "我叫什么名字？"
    });

    expect(context.userMessageForModel).toContain("<recalled_claims>");
    expect(context.userMessageForModel).toContain("user/self.preferred_name = Mason");
    const relevantIndex = context.userMessageForModel.indexOf("<relevant_recall>");
    if (relevantIndex >= 0) {
      expect(context.userMessageForModel.indexOf("用户希望被称呼为 Mason")).toBeLessThan(relevantIndex);
    }
    expect(context.userMessageForModel.match(/用户希望被称呼为 Mason/g)).toHaveLength(1);
  });

  test("renders user identity claims in user_profile instead of generic recalled claims", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"],
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "我叫什么名字？"
    });

    const profileSection = context.userMessageForModel.match(/<user_profile>[\s\S]*?<\/user_profile>/)?.[0] ?? "";
    const claimsSection = context.userMessageForModel.match(/<recalled_claims>[\s\S]*?<\/recalled_claims>/)?.[0] ?? "";
    expect(profileSection).toContain("user/self.preferred_name = Mason");
    expect(claimsSection).not.toContain("user/self.preferred_name = Mason");
  });

  test("renders pinned global memory separately from generic recall", () => {
    const prefix = buildMemoryUserMessagePrefix([{
      ...recallItem,
      id: "global:MEMORY.md",
      kind: "state",
      scope: "global",
      statement: "全局规则：最终回复需要说明改动文件和剩余风险。",
      reason: "global memory brief",
      pinned: true
    }]);

    const globalSection = prefix.match(/<global_memory>[\s\S]*?<\/global_memory>/)?.[0] ?? "";
    const relevantSection = prefix.match(/<relevant_recall>[\s\S]*?<\/relevant_recall>/)?.[0] ?? "";
    expect(globalSection).toContain("全局规则：最终回复需要说明改动文件和剩余风险。");
    expect(relevantSection).not.toContain("全局规则");
  });

  test("dedupes and limits final memory items before injecting them into the user message", async () => {
    const store = createMemoryV2Store();
    store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume memory uses Markdown as the source of truth.",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume memory uses Markdown as source of truth",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    for (let index = 0; index < 6; index += 1) {
      store.writeEntry({
        kind: "decision",
        targetScope: "workspace",
        statement: `Memory retrieval candidate ${index} should compete for prompt budget.`,
        confidence: "high",
        tags: ["memory"],
        appliesWhen: { workspaceSlug: "demo" }
      });
    }

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "memory source of truth retrieval design"
    });

    expect(context.items.length).toBeLessThanOrEqual(5);
    expect(context.items.filter((item) => item.statement.includes("source of truth"))).toHaveLength(1);
    expect(context.prefix.match(/source of truth/g)).toHaveLength(1);
  });

  test("injects assistant name claim separately from conversation history", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望用 Alice 称呼助手",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"],
        claim: {
          subject: "assistant/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      }
    });
    createMemoryV2Store().appendRunArchive({
      workspaceSlug: "demo",
      runId: "identity-noise",
      record: {
        userMessage: "你是谁？",
        assistantMessage: "我是 Lume。",
        threadId: "thread-secret",
        modelId: "glm-4.5"
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "你是谁？"
    });

    expect(context.userMessageForModel).toContain("<recalled_claims>");
    expect(context.userMessageForModel).toContain("assistant/self.preferred_name = Alice");
    expect(context.userMessageForModel).not.toContain("user/self.preferred_name = Mason");
    expect(context.userMessageForModel).not.toContain("<relevant_recall>\n  - [workspace:run:");
    expect(context.userMessageForModel).not.toContain("thread-secret");
    expect(context.userMessageForModel).not.toContain("glm-4.5");
  });

  test("keeps weak history when identity question explicitly asks prior context", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望用 Alice 称呼助手",
        confidence: "high",
        claim: {
          subject: "assistant/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      }
    });
    createMemoryV2Store().appendRunArchive({
      workspaceSlug: "demo",
      runId: "identity-history",
      record: {
        userMessage: "你是谁？",
        assistantMessage: "我是 Lume。",
        threadId: "thread-secret",
        modelId: "glm-4.5"
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "之前我问你是谁时你怎么回答的？"
    });

    expect(context.userMessageForModel).toContain("<recalled_claims>");
    expect(context.userMessageForModel).toContain("<conversation_history>");
    expect(context.userMessageForModel).not.toContain("thread-secret");
    expect(context.userMessageForModel).not.toContain("glm-4.5");
  });

  test("keeps run archive in conversation history when no claim is available", async () => {
    createMemoryV2Store().appendRunArchive({
      workspaceSlug: "demo",
      runId: "identity-noise",
      record: {
        userMessage: "你是谁？",
        assistantMessage: "我是 Lume。",
        threadId: "thread-secret",
        modelId: "glm-4.5"
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "你是谁？"
    });

    expect(context.userMessageForModel).toContain("<conversation_history>");
    expect(context.userMessageForModel).toContain("你是谁？");
    expect(context.userMessageForModel).not.toContain("thread-secret");
    expect(context.userMessageForModel).not.toContain("modelId");
  });

  test("uses compact run summaries instead of raw archived payloads", async () => {
    createMemoryV2Store().appendRunArchive({
      workspaceSlug: "demo",
      runId: "summary-history",
      record: {
        summary: "User asked: compact memory recall summary.",
        userMessage: "TAIL_SHOULD_NOT_APPEAR raw archived message",
        threadId: "thread-secret"
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "之前我们聊过什么？"
    });

    expect(context.userMessageForModel).toContain("compact memory recall summary");
    expect(context.userMessageForModel).not.toContain("TAIL_SHOULD_NOT_APPEAR");
    expect(context.userMessageForModel).not.toContain("thread-secret");
  });

  test("injects user preference claims without relying on previous run history", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户偏好默认用中文回答",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preference",
          object: "默认用中文回答"
        }
      }
    });
    createMemoryV2Store().appendRunArchive({
      workspaceSlug: "demo",
      runId: "preference-noise",
      record: {
        userMessage: "我的默认回复偏好是什么？",
        assistantMessage: "可能是英文。",
        threadId: "thread-secret",
        modelId: "glm-4.5"
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "我的默认回复偏好是什么？"
    });

    expect(context.userMessageForModel).toContain("<recalled_claims>");
    expect(context.userMessageForModel).toContain("user/self.preference = 默认用中文回答");
    expect(context.userMessageForModel).not.toContain("  <conversation_history>");
    expect(context.userMessageForModel).not.toContain("thread-secret");
    expect(context.userMessageForModel).not.toContain("glm-4.5");
  });

  test("injects writing style claims for writing tasks even when the query does not name memory", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户写作风格偏好简洁、有温度",
        confidence: "high",
        tags: ["voice", "writing-style"],
        claim: {
          subject: "user/self",
          predicate: "writing_style",
          object: "简洁、有温度"
        }
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "帮我写一段项目介绍"
    });

    expect(context.userMessageForModel).toContain("<user_voice>");
    expect(context.userMessageForModel).toContain("Treat <user_voice> as tone and writing-style guidance only");
    expect(context.userMessageForModel).toContain("user/self.writing_style = 简洁、有温度");
  });

  test("injects tagged writing-style memories as user voice even without a claim", async () => {
    createMemoryV2Store().writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "用户写作时偏好短句、少用感叹号",
      confidence: "high",
      tags: ["voice", "writing-style"],
      appliesWhen: {
        workspaceSlug: "demo"
      }
    }, {
      source: {
        type: "manual"
      }
    });

    const context = await buildMemoryV2UserMessageContext({
      workspaceSlug: "demo",
      sessionType: "main",
      userMessage: "帮我写一段产品介绍"
    });

    expect(context.userMessageForModel).toContain("<user_voice>");
    expect(context.userMessageForModel).toContain("用户写作时偏好短句、少用感叹号");
  });

  test("persona present → renders <persona_profile> after <user_profile> with summary/prefs/rules", () => {
    writePersona("global", undefined,
      "# 用户画像\n" +
      "## 一句话定位\n独立开发者\n" +
      "## 长期偏好\n- 用 TypeScript\n- 简洁代码\n- 测试先行\n" +
      "## 交互协议\n- 不要用 var\n- 回复用中文\n" +
      "## 演进轨迹\n- 2026-08 偏好 TS");

    // 加入一个会进入 <user_profile> 的 profile 项以验证段顺序
    const prefix = buildMemoryUserMessagePrefix([{
      ...recallItem,
      id: "mem_profile",
      statement: "用户希望被称呼为 Alice"
    }], { workspaceSlug: "demo" });

    const section = prefix.match(/<persona_profile>[\s\S]*?<\/persona_profile>/)?.[0] ?? "";
    expect(section).toContain("独立开发者");
    expect(section).toContain("- 用 TypeScript");
    expect(section).toContain("- 简洁代码");
    expect(section).toContain("- 不要用 var");
    // persona_profile 位于 user_profile 之后
    const userProfileIdx = prefix.indexOf("<user_profile>");
    const personaProfileIdx = prefix.indexOf("  <persona_profile>");
    expect(userProfileIdx).toBeGreaterThan(-1);
    expect(personaProfileIdx).toBeGreaterThan(userProfileIdx);
    // 头部指令含 persona_profile 规则
    expect(prefix).toContain("Treat <persona_profile> as a synthesized overview");
    // 演进轨迹不应注入（仅 summary + preferences + interactionRules）
    expect(section).not.toContain("2026-08 偏好 TS");
  });

  test("persona absent → <persona_profile> section omitted (no empty tags)", () => {
    const prefix = buildMemoryUserMessagePrefix([recallItem], { workspaceSlug: "demo" });
    expect(prefix).not.toContain("  <persona_profile>");
    expect(prefix).not.toContain("</persona_profile>");
  });

  test("persona with only empty fields → section omitted", () => {
    writePersona("workspace", "demo", "# 用户画像\n（无内容）");
    const prefix = buildMemoryUserMessagePrefix([recallItem], { workspaceSlug: "demo" });
    expect(prefix).not.toContain("  <persona_profile>");
    expect(prefix).not.toContain("</persona_profile>");
  });

  test("persona section renders even when no memory items exist", () => {
    writePersona("global", undefined,
      "# 用户画像\n## 一句话定位\n仅 persona 存在\n## 长期偏好\n- 偏好简洁");

    const prefix = buildMemoryUserMessagePrefix([], {});
    expect(prefix).toContain("  <persona_profile>");
    expect(prefix).toContain("仅 persona 存在");
    expect(prefix).toContain("- 偏好简洁");
  });

  test("persona preferences truncated to 5 and interactionRules to 3", () => {
    const prefs = Array.from({ length: 7 }, (_, i) => `- 偏好${i}`).join("\n");
    const rules = Array.from({ length: 5 }, (_, i) => `- 规则${i}`).join("\n");
    writePersona("global", undefined,
      `# 用户画像\n## 一句话定位\n开发者\n## 长期偏好\n${prefs}\n## 交互协议\n${rules}`);

    const prefix = buildMemoryUserMessagePrefix([recallItem], { workspaceSlug: "demo" });
    const section = prefix.match(/<persona_profile>[\s\S]*?<\/persona_profile>/)?.[0] ?? "";
    expect(section).toContain("偏好0");
    expect(section).toContain("偏好4");
    expect(section).not.toContain("偏好5");
    expect(section).toContain("规则0");
    expect(section).toContain("规则2");
    expect(section).not.toContain("规则3");
  });
});
