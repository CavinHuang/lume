import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@lume/shared";
import { finalizeStreamRefresh } from "./stream-finalizer";

function createMessage(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: id,
    createdAt: Date.now()
  };
}

describe("stream-finalizer", () => {
  test("应先应用刷新结果再清理 streaming 状态", async () => {
    const logs: string[] = [];
    let appliedLength = 0;
    let appliedHasMore = false;

    await finalizeStreamRefresh({
      fetchRecentMessages: async () => ({
        messages: Array.from({ length: 12 }, (_, index) => createMessage(`m-${index + 1}`)),
        hasMore: true
      }),
      applyRefresh: (result) => {
        logs.push("apply");
        appliedLength = result.messages.length;
        appliedHasMore = result.hasMore;
      },
      clearStreaming: () => {
        logs.push("clear");
      }
    });

    expect(logs).toEqual(["apply", "clear"]);
    expect(appliedLength).toBe(12);
    expect(appliedHasMore).toBeTrue();
  });

  test("刷新失败时也必须清理 streaming 状态", async () => {
    const logs: string[] = [];
    let capturedError = "";

    await finalizeStreamRefresh({
      fetchRecentMessages: async () => {
        throw new Error("fetch failed");
      },
      applyRefresh: () => {
        logs.push("apply");
      },
      clearStreaming: () => {
        logs.push("clear");
      },
      onFetchError: (error) => {
        logs.push("error");
        capturedError = error instanceof Error ? error.message : String(error);
      }
    });

    expect(logs).toEqual(["error", "clear"]);
    expect(capturedError).toBe("fetch failed");
  });
});
