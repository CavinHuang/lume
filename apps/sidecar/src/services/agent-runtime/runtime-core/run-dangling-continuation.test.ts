import { describe, expect, test } from "bun:test";
import type { RuntimeCoreSessionContextMessage } from "./session-store";
import { resolveDanglingFallbackContinuations } from "./run";

function assistantMessage(blocks: unknown[]): RuntimeCoreSessionContextMessage {
  return { role: "assistant", content: blocks };
}

function toolResultMessage(toolCallId: string): RuntimeCoreSessionContextMessage {
  return { role: "toolResult", toolCallId };
}

describe("resolveDanglingFallbackContinuations", () => {
  test("returns undefined without the dangling-fallback marker", () => {
    const messages = [assistantMessage([{ type: "tool_use", id: "t1", name: "Read", input: {} }])];
    expect(resolveDanglingFallbackContinuations({ runtimeContinuation: { sourceRunId: "run-1" } }, messages)).toBeUndefined();
    expect(resolveDanglingFallbackContinuations(undefined, messages)).toBeUndefined();
  });

  test("replays read-only tools and injects placeholders for side-effect tools", () => {
    const messages: RuntimeCoreSessionContextMessage[] = [
      { role: "user", content: "run this" },
      assistantMessage([
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }
      ])
    ];
    const continuations = resolveDanglingFallbackContinuations(
      { runtimeContinuation: { source: "dangling-fallback", sourceRunId: "run-1" } },
      messages
    );
    expect(continuations).toHaveLength(2);
    expect(continuations?.[0]).toEqual({
      toolCall: { id: "t1", name: "Read", input: { file_path: "a.txt" } }
    });
    expect(continuations?.[1]?.toolResult).toMatchObject({
      tool_use_id: "t2",
      is_error: true
    });
  });

  test("skips tool_use blocks already answered by tool results", () => {
    const messages: RuntimeCoreSessionContextMessage[] = [
      assistantMessage([{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
      toolResultMessage("t1")
    ];
    expect(
      resolveDanglingFallbackContinuations(
        { runtimeContinuation: { source: "dangling-fallback" } },
        messages
      )
    ).toBeUndefined();
  });

  test("returns undefined for clean history", () => {
    const messages: RuntimeCoreSessionContextMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "done" }] }
    ];
    expect(
      resolveDanglingFallbackContinuations(
        { runtimeContinuation: { source: "dangling-fallback" } },
        messages
      )
    ).toBeUndefined();
  });
});
