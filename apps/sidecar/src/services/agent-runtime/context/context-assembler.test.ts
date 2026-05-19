import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceRecorder } from "../trace/trace-recorder";
import { createFileBackedLumeTraceStore } from "../trace/trace-store";
import { ContextAssembler } from "./context-assembler";

describe("ContextAssembler", () => {
  const originalConfigDir = process.env.LUME_CONFIG_DIR;

  test("assembles existing prompt builder output with budget trace", async () => {
    const result = await new ContextAssembler().assemble({
      threadId: "thread-1",
      runId: "run-1",
      userMessage: "hello",
      workspaceName: "Demo",
      resolvedModelId: "gpt-5.4-mini",
      availableTools: ["Read", "Write"],
      tokenBudget: 1000
    });

    expect(result.systemPrompt).toContain("You are Lume.");
    expect(result.dynamicContext).toContain("<thread_state>");
    expect(result.memoryContext).toBe("");
    expect(result.budget.total).toBe(1000);
    expect(result.trace.tokenUsageEstimate).toBeGreaterThan(0);
  });

  test("adds message attachment brief to model-facing user message", async () => {
    const result = await new ContextAssembler().assemble({
      threadId: "thread-attachments",
      runId: "run-attachments",
      userMessage: "summarize this",
      resolvedModelId: "gpt-5.4-mini",
      availableTools: ["Read"],
      tokenBudget: 1000,
      messageAttachments: [{
        id: "att-1",
        filename: "brief.md",
        mediaType: "text/markdown",
        size: 2048,
        threadPath: "docs/brief.md"
      }]
    });

    expect(result.userMessageForModel).toContain("summarize this");
    expect(result.userMessageForModel).toContain("本轮用户附加了以下文件：");
    expect(result.userMessageForModel).toContain("brief.md (text/markdown, 2 KB): docs/brief.md");
  });

  test("records context assembly and memory retrieval spans when trace context is provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-context-trace-"));
    try {
      process.env.LUME_CONFIG_DIR = dir;
      const store = createFileBackedLumeTraceStore(dir);
      const recorder = new TraceRecorder(store);
      const trace = await recorder.startTrace({
        threadId: "thread-1",
        runId: "run-1",
        name: "test trace"
      });

      await new ContextAssembler().assemble({
        threadId: "thread-1",
        runId: "run-1",
        userMessage: "hello",
        workspaceSlug: "missing-memory-workspace",
        resolvedModelId: "gpt-5.4-mini",
        availableTools: ["Read"],
        tokenBudget: 1000,
        trace: {
          recorder,
          traceId: trace.id
        }
      });

      const stored = await store.get(trace.id);
      expect(stored?.spans.map((span) => span.type)).toEqual([
        "context_assembly",
        "memory_retrieval"
      ]);
      expect(stored?.spans[0]?.status).toBe("completed");
      const contextOutput = stored?.spans[0]?.output as {
        budget?: { total?: number };
        tokenUsageEstimate?: number;
      } | undefined;
      expect(contextOutput?.budget?.total).toBe(1000);
      expect(contextOutput?.tokenUsageEstimate).toBeGreaterThan(0);
      const memorySpanStatus = stored?.spans[1]?.status;
      expect(memorySpanStatus === "completed" || memorySpanStatus === "failed").toBeTrue();
    } finally {
      process.env.LUME_CONFIG_DIR = originalConfigDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
