import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LumeRuntimeEvent, SDKMessage } from "@lume/shared";
import { LumeRunObserver } from "./run-observer";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LumeRunObserver persist 标记 (#551)", () => {
  test("persist:false 的截图块不落盘,文本块保留;全 ephemeral 时回退 output 占位", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-run-observer-ephemeral-"));
    directories.push(sessionDir);
    const observer = await LumeRunObserver.create({
      sessionDir,
      threadId: "thread-1",
      userMessage: "hello",
      model: { provider: "openai", modelId: "gpt-test" },
    });

    observer.recordSdkMessage({
      type: "tool_result",
      result: {
        tool_use_id: "tool-1",
        tool_name: "browser",
        content: [
          { type: "text", text: "screenshot saved" },
          { type: "image", data: "QkFTRTY0", mimeType: "image/png", _meta: { persist: false, ephemeral: "trusted_runtime" } }
        ],
        output: "占位文本",
        is_error: false
      }
    } as SDKMessage);
    // 全部内容块均带 ephemeral 标记 → 回退 result.output 占位
    observer.recordSdkMessage({
      type: "tool_result",
      result: {
        tool_use_id: "tool-2",
        tool_name: "computer",
        content: [{ type: "image", data: "U2hvdA==", mimeType: "image/png", _meta: { persist: false } }],
        output: "screenshot placeholder",
        is_error: false
      }
    } as SDKMessage);
    await observer.flush();

    // 从 items.jsonl 落盘内容断言（items 经 stateStore appendItem 写入 runs/ 目录）
    const runsDir = join(sessionDir, "runs");
    const lines: string[] = [];
    for (const file of readdirSync(runsDir)) {
      if (file.endsWith(".items.jsonl")) {
        lines.push(...readFileSync(join(runsDir, file), "utf8").split("\n").filter(Boolean));
      }
    }
    const outputs = lines
      .map((line) => JSON.parse(line) as { type?: string; output?: unknown })
      .filter((item) => item.type === "tool_result")
      .map((item) => item.output);
    expect(outputs).toHaveLength(2);
    expect(JSON.stringify(outputs[0])).toContain("screenshot saved");
    expect(JSON.stringify(outputs[0])).not.toContain("QkFTRTY0");
    expect(outputs[1]).toBe("screenshot placeholder");
  });
});

describe("LumeRunObserver retry events", () => {
  test("keeps repeated retry phases distinct across provider fallback routes", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-run-observer-retry-"));
    directories.push(sessionDir);
    const observer = await LumeRunObserver.create({
      sessionDir,
      threadId: "thread-1",
      userMessage: "hello",
      model: { provider: "openai", modelId: "gpt-test" },
    });
    const events: LumeRuntimeEvent[] = [];
    const retryMessage: SDKMessage = {
      type: "system",
      subtype: "api_retry",
      phase: "waiting",
      attempt: 5,
      max_retries: 5,
      retry_delay_ms: 0,
      error_status: 503,
      error: "server_error",
      session_id: "thread-1",
    };

    observer.recordSdkMessage(retryMessage, (event) => events.push(event));
    observer.recordSdkMessage(retryMessage, (event) => events.push(event));
    await observer.flush();

    const retryEvents = events.filter((event) => event.type === "model.retry");
    expect(retryEvents).toHaveLength(2);
    expect(new Set(retryEvents.map((event) => event.id)).size).toBe(2);
    expect(retryEvents.map((event) => event.sequence)).toEqual([0, 1]);
  });
});

describe("LumeRunObserver tool_call 终态与 usage 口径 (#256)", () => {
  test("tool_result 回写对应 tool_call 的 completed/failed 终态", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-run-observer-settle-"));
    directories.push(sessionDir);
    const observer = await LumeRunObserver.create({
      sessionDir,
      threadId: "thread-1",
      userMessage: "hello",
      model: { provider: "openai", modelId: "gpt-test" },
    });

    observer.recordSdkMessage({
      type: "assistant",
      session_id: "thread-1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-ok", name: "browser_navigate", input: { url: "https://a.dev" } },
          { type: "tool_use", id: "tu-err", name: "browser_click", input: {} },
        ],
      },
    } as unknown as SDKMessage);
    observer.recordSdkMessage({
      type: "tool_result",
      session_id: "thread-1",
      result: { tool_use_id: "tu-ok", tool_name: "browser_navigate", output: "ok" },
    } as unknown as SDKMessage);
    observer.recordSdkMessage({
      type: "tool_result",
      session_id: "thread-1",
      result: { tool_use_id: "tu-err", tool_name: "browser_click", output: { code: "timeout" }, is_error: true },
    } as unknown as SDKMessage);
    await observer.flush();

    const state = await observer.getRunState();
    const toolCalls = (state?.generatedItems ?? []).filter((item) => item.type === "tool_call");
    const byId = new Map(toolCalls.map((item) => [item.id, item]));
    expect((byId.get("tu-ok") as { status?: string }).status).toBe("completed");
    expect((byId.get("tu-ok") as { endedAt?: string }).endedAt).toBeTruthy();
    expect((byId.get("tu-err") as { status?: string }).status).toBe("failed");
  });

  test("tool_result item 落盘剥离 persist:false 截图块,base64 不进 items.jsonl (#600/#630)", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-run-observer-output-"));
    directories.push(sessionDir);
    const observer = await LumeRunObserver.create({
      sessionDir,
      threadId: "thread-1",
      userMessage: "hello",
      model: { provider: "openai", modelId: "gpt-test" },
    });

    const pixels = "A".repeat(50_000);
    observer.recordSdkMessage({
      type: "assistant",
      session_id: "thread-1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-shot", name: "mcp__browser__screenshot", input: {} }],
      },
    } as unknown as SDKMessage);
    observer.recordSdkMessage({
      type: "tool_result",
      session_id: "thread-1",
      result: {
        tool_use_id: "tu-shot",
        tool_name: "mcp__browser__screenshot",
        output: "[Image: image/jpeg]",
        content: [
          { type: "text", text: '{"ok":true}' },
          // 与 screenshotToolResult 同构:image block 必带 persist:false
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: pixels }, _meta: { persist: false, ephemeral: "trusted_runtime" } },
        ],
      },
    } as unknown as SDKMessage);
    await observer.flush();

    const state = await observer.getRunState();
    const shot = (state?.generatedItems ?? []).find((item) => item.type === "tool_result" && item.toolCallId === "tu-shot") as { output?: Array<Record<string, unknown>> };
    // 文本元数据保留,image 块被剥离
    const blocks = Array.isArray(shot?.output) ? shot!.output! : [];
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text?: string }).text).toBe('{"ok":true}');
    expect(JSON.stringify(shot?.output)).not.toContain(pixels);
  });

  test("usage.totalTokens 取计费累计而非最新上下文快照", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-run-observer-usage-"));
    directories.push(sessionDir);
    const observer = await LumeRunObserver.create({
      sessionDir,
      threadId: "thread-1",
      userMessage: "hello",
      model: { provider: "openai", modelId: "gpt-test" },
    });

    observer.recordSdkMessage({
      type: "result",
      session_id: "thread-1",
      contextUsage: { source: "provider", inputTokens: 90, outputTokens: 10, totalTokens: 100, contextWindow: 200_000 },
      billingUsage: {
        cumulative: { inputTokens: 300, outputTokens: 60, cacheReadInputTokens: 40, cacheCreationInputTokens: 0, cachedTokens: 40, totalTokens: 400 },
        records: [],
        totalCostUSD: 0.5,
      },
    } as unknown as SDKMessage);
    await observer.flush();

    const state = await observer.getRunState();
    // in/out/total 同为累计口径(400),上下文快照(100)只存在于 usage.context
    expect(state?.usage.inputTokens).toBe(300);
    expect(state?.usage.outputTokens).toBe(60);
    expect(state?.usage.totalTokens).toBe(400);
    expect(state?.usage.context?.totalTokens).toBe(100);
  });
});
