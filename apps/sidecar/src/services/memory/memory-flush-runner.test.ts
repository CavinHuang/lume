import { describe, expect, test } from "bun:test";
import type { MemorySaveInput } from "@lume/shared";
import { runStructuredMemoryFlush } from "./memory-flush-runner";

describe("memory-flush-runner", () => {
  test("runStructuredMemoryFlush 应解析 JSON entries 并通过 memory writer 保存", async () => {
    const saved: MemorySaveInput[] = [];

    const result = await runStructuredMemoryFlush({
      workspaceSlug: "demo",
      sessionId: "session-1",
      rawOutput: JSON.stringify({
        entries: [
          {
            kind: "decision",
            scope: "workspace",
            title: "Structured flush",
            content: "Memory Flush should save structured durable memories.",
            summary: "Structured flush writes durable memory.",
            importance: 5,
            confidence: 0.8,
            tags: ["memory", "flush"],
            sourceMessageIds: ["msg-1", "msg-2"]
          },
          {
            kind: "episode",
            content: "   ",
            importance: 3
          }
        ]
      }),
      deps: {
        writeWorkspaceMemory: async (input) => {
          saved.push(input);
          return { path: "memory/2026-04-26.md", bytes: 12, itemId: "item-1" };
        }
      }
    });

    expect(result.executed).toBeTrue();
    expect(result.savedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.payload).toEqual({
      workspaceSlug: "demo",
      sessionId: "session-1",
      entries: [
        expect.objectContaining({
          kind: "decision",
          content: "Memory Flush should save structured durable memories.",
          importance: 5
        })
      ]
    });
    expect(saved).toEqual([
      expect.objectContaining({
        workspaceSlug: "demo",
        kind: "decision",
        scope: "workspace",
        source: "flush",
        title: "Structured flush",
        sourceSessionId: "session-1",
        sourceMessageIds: ["msg-1", "msg-2"],
        importance: 5,
        confidence: 0.8
      })
    ]);
  });

  test("runStructuredMemoryFlush 应接受 fenced JSON 且空 entries 不写入", async () => {
    const saved: MemorySaveInput[] = [];

    const result = await runStructuredMemoryFlush({
      workspaceSlug: "demo",
      sessionId: "session-1",
      rawOutput: "```json\n{\"entries\":[]}\n```",
      deps: {
        writeWorkspaceMemory: async (input) => {
          saved.push(input);
          return { path: "memory/2026-04-26.md", bytes: 12 };
        }
      }
    });

    expect(result.executed).toBeTrue();
    expect(result.savedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.payload?.entries).toEqual([]);
    expect(saved).toEqual([]);
  });
});
