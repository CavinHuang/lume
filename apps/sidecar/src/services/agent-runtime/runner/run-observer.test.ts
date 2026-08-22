import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
