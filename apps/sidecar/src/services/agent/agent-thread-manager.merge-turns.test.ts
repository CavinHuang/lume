import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentThread,
  getAgentThreadMessages
} from "./agent-thread-manager";
import {
  createAssistantMessageVersion,
  createUserMessageVersion,
  initializeVersionStoreFromMessages
} from "./agent-message-versioning-service";
import { createOrResumeRuntimeCoreSessionManager } from "../agent-runtime/runtime-core/session-store";

/**
 * 模拟 SDK 的 agentic loop 在 transcript 中写入多个 assistant turn。
 *
 * 在一次 session.prompt() 调用中，SDK 会为每次模型 API 调用创建一个 assistant turn：
 *   1. assistant: thinking + text + toolCall (stopReason=toolUse)
 *   2. toolResult: 工具执行结果
 *   3. assistant: text + toolCall:AskUserQuestion (stopReason=toolUse)
 *   4. toolResult: 用户回答
 *   5. assistant: 最终 text (stopReason=stop)
 *
 * getAgentThreadMessages 应将同一次请求中的多个 assistant turn 合并为一条消息。
 */
describe("agent-thread-manager multi-turn merge", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-merge-turns-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("SDK agentic loop 多个 assistant turn 应合并为一条消息", () => {
    const session = createAgentThread("multi-turn merge");
    const sm = createOrResumeRuntimeCoreSessionManager(
      process.cwd(),
      session.id
    );

    sm.appendModelChange("zai", "glm-5-turbo");

    // 用户消息
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "你是谁？" }],
      timestamp: Date.now()
    });

    // assistant turn 1: thinking + 中间文本 + 工具调用 (stopReason=toolUse)
    sm.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "toolUse",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: "thinking", thinking: "用户在问我是谁，先读取身份文件" },
        { type: "text", text: "让我先读取身份文件。" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "SOUL.md" } }
      ],
      timestamp: Date.now()
    });

    // 工具结果
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "# SOUL.md 内容..." }],
      isError: false,
      timestamp: Date.now()
    });

    // assistant turn 2: 正式回答 + AskUserQuestion (stopReason=toolUse)
    sm.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "toolUse",
      usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: "text", text: "你好！我是工作空间里的 AI 伙伴。想问你一个问题：" },
        { type: "toolCall", id: "call_2", name: "AskUserQuestion", arguments: { questions: [] } }
      ],
      timestamp: Date.now()
    });

    // AskUserQuestion 工具结果
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "AskUserQuestion",
      content: [{ type: "text", text: '{"answers":{"question":"先不聊这个"}}' }],
      isError: false,
      timestamp: Date.now()
    });

    // assistant turn 3: 最终回答 (stopReason=stop)
    sm.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "stop",
      usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 330, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: "text", text: "好的，有什么需要帮忙的直接说。" }
      ],
      timestamp: Date.now()
    });

    const messages = getAgentThreadMessages(session.id);

    // 应该只有 2 条消息：1 条 user + 1 条合并后的 assistant
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("你是谁？");

    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    // reasoning 应该来自第一个 turn
    expect(assistant.reasoning).toContain("用户在问我是谁");
    // content 应该包含所有 turn 的文本，合并拼接
    expect(assistant.content).toContain("让我先读取身份文件");
    expect(assistant.content).toContain("你好！我是工作空间里的 AI 伙伴");
    expect(assistant.content).toContain("好的，有什么需要帮忙的直接说");

    // #527 去重:tool 合并素材由 transcript 投影现场合成,版本 store 读回
    // 不再冗余内嵌非 compaction 片段(原始流唯一正典是 sdkMessages.jsonl)
    expect(assistant.sdkMessages).toBeUndefined();
  });

  test("reasoning-only + content-only 两个 turn 应合并", () => {
    const session = createAgentThread("reasoning merge");
    const sm = createOrResumeRuntimeCoreSessionManager(
      process.cwd(),
      session.id
    );

    sm.appendModelChange("zai", "glm-5-turbo");

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "测试" }],
      timestamp: Date.now()
    });

    // assistant turn 1: 只有 thinking + toolCall，没有 text
    sm.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "toolUse",
      usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: "thinking", thinking: "先搜索一下" },
        { type: "toolCall", id: "call_a", name: "grep", arguments: { query: "test" } }
      ],
      timestamp: Date.now()
    });

    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_a",
      toolName: "grep",
      content: [{ type: "text", text: "搜索结果..." }],
      isError: false,
      timestamp: Date.now()
    });

    // assistant turn 2: 只有 text
    sm.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "stop",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: "text", text: "搜索完成，结果如下。" }
      ],
      timestamp: Date.now()
    });

    const messages = getAgentThreadMessages(session.id);
    expect(messages).toHaveLength(2);

    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.reasoning).toContain("先搜索一下");
    expect(assistant.content).toContain("搜索完成");

    // #527 去重:tool 合并素材由 transcript 投影现场合成,版本 store 读回
    // 不再冗余内嵌非 compaction 片段(原始流唯一正典是 sdkMessages.jsonl)
    expect(assistant.sdkMessages).toBeUndefined();
  });

  test("不同用户消息之间的 assistant 不应合并", () => {
    const session = createAgentThread("separate conversations");
    const sm = createOrResumeRuntimeCoreSessionManager(
      process.cwd(),
      session.id
    );

    sm.appendModelChange("zai", "glm-5-turbo");

    // 第一轮对话
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "问题1" }],
      timestamp: Date.now()
    });
    sm.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "stop",
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: "text", text: "回答1" }],
      timestamp: Date.now()
    });

    // 第二轮对话
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "问题2" }],
      timestamp: Date.now()
    });
    sm.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "stop",
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: "text", text: "回答2" }],
      timestamp: Date.now()
    });

    const messages = getAgentThreadMessages(session.id);
    // 应该有 4 条：user1, assistant1, user2, assistant2（不合并）
    expect(messages).toHaveLength(4);
    expect(messages[0]!.content).toBe("问题1");
    expect(messages[1]!.content).toBe("回答1");
    expect(messages[2]!.content).toBe("问题2");
    expect(messages[3]!.content).toBe("回答2");
  });

  test("单个 assistant turn（无工具调用）不应被影响", () => {
    const session = createAgentThread("single turn");
    const sm = createOrResumeRuntimeCoreSessionManager(
      process.cwd(),
      session.id
    );

    sm.appendModelChange("zai", "glm-5-turbo");

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "简单问题" }],
      timestamp: Date.now()
    });
    sm.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "stop",
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: "thinking", thinking: "简单思考" },
        { type: "text", text: "简单回答" }
      ],
      timestamp: Date.now()
    });

    const messages = getAgentThreadMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toBe("简单回答");
    expect(messages[1]!.reasoning).toBe("简单思考");
  });

  test("已有版本存储时应优先返回原始 sdkMessages，而不是被空 transcript 覆盖", () => {
    const session = createAgentThread("canonical sdk history");
    initializeVersionStoreFromMessages(session.id, []);

    const userVersion = createUserMessageVersion({
      sessionId: session.id,
      content: "请帮我搜索",
      createdAt: 1_000
    });

    createAssistantMessageVersion({
      sessionId: session.id,
      turnId: userVersion.turnId,
      message: {
        id: "assistant-msg",
        role: "assistant",
        content: "已完成搜索并总结",
        reasoning: "先搜索再总结",
        createdAt: 2_000,
        model: "anthropic/claude-sonnet-4-5",
        sdkMessages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "先搜索再总结" },
                { type: "tool_use", id: "tool-1", name: "WebSearch", input: { query: "Lume SDK" } },
                { type: "text", text: "已完成搜索并总结" }
              ]
            }
          },
          {
            type: "user",
            parent_tool_use_id: "tool-1",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tool-1", content: "search ok" }
              ]
            }
          },
          {
            type: "result",
            subtype: "success",
            duration_ms: 123,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0
            }
          } as any
        ] as any
      }
    });

    const messages = getAgentThreadMessages(session.id);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("请帮我搜索");
    expect(messages[1]!.content).toBe("已完成搜索并总结");
    expect(messages[1]!.reasoning).toBe("先搜索再总结");
    // #527 去重后 sdkMessages 落盘被裁,改用 model 探针验证数据来源仍是
    // version store(优先于空 transcript 的读优先级修复不回归)
    expect(messages[1]!.model).toBe("anthropic/claude-sonnet-4-5");
    expect(messages[1]!.sdkMessages).toBeUndefined();
  });
});
