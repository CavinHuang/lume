import { describe, expect, test } from "bun:test";
import {
  compactConversation,
  createAutoCompactState,
  microCompactMessages,
  prepareCompaction,
  serializeConversation,
  shouldAutoCompact,
  truncateSerializedConversation,
} from "./compact.js";

const VALID_SUMMARY = `## Goal
Preserve the current task.

## Constraints & Preferences
- Keep recent context verbatim.

## Progress
### Done
- [x] Inspected history.

### In Progress
- [ ] Continue the task.

### Blocked
- (none)

## Key Decisions
- **Retention**: Keep the recent tail.

## Next Steps
1. Continue from the latest user request.

## Critical Context
- The latest task is authoritative.`;

const VALID_TURN_PREFIX_SUMMARY = `## Original Request
合同审查：内容违规时怎么处理的？

## Early Progress
- Searched the relevant implementation.

## Context for Suffix
- The retained Grep result belongs to the current request.`;

function providerWithSummary(summary = VALID_SUMMARY, stopReason = "end_turn") {
  const requests: any[] = [];
  return {
    requests,
    provider: {
      async createMessage(input: any) {
        requests.push(input);
        return {
          content: [{ type: "text", text: summary }],
          stopReason,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    } as any,
  };
}

describe("context compaction", () => {
  test("removes image payloads from summaries while retaining action facts", async () => {
    const { provider, requests } = providerWithSummary();
    const messages = [
      { role: "user", content: "old request" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "shot", name: "Computer", input: { action: "click" } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "shot",
          _meta: { computerUseAction: { actionId: "action-1", action: "click", phase: "observed", window: { id: 42, app: "微信" } } },
          content: [{ type: "image", source: { type: "base64", data: "SECRET_BASE64" } }],
        }],
      },
      { role: "user", content: "latest request" },
    ] as any[];

    const result = await compactConversation(
      provider,
      "test-model",
      messages,
      createAutoCompactState(),
      { keepRecentTokens: 1, trigger: "manual" },
    );

    expect(JSON.stringify(requests)).not.toContain("SECRET_BASE64");
    expect(result.compacted).toBeTrue();
    expect(JSON.stringify(result.compactedMessages[0])).toContain("action-1: click on 微信#42");
    expect(result.compactedMessages.at(-1)).toBe(messages.at(-1));
  });

  test("screenshots alone do not trigger estimated auto compaction", () => {
    const images = Array.from({ length: 100 }, () => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "x".repeat(40_000) },
    }));
    expect(shouldAutoCompact([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "shot", content: images }] },
    ], "test-model", createAutoCompactState())).toBeFalse();
  });

  test("retains a recent raw turn and never starts the tail with a tool result", () => {
    const messages = [
      { role: "user", content: "old".repeat(20_000) },
      { role: "assistant", content: [{ type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "违规" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "grep-1", content: "result" }] },
      { role: "user", content: "合同审查：内容违规时怎么处理的？" },
      { role: "assistant", content: [{ type: "tool_use", id: "grep-2", name: "Grep", input: { pattern: "内容违规" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "grep-2", content: "current result" }] },
    ] as any[];

    const preparation = prepareCompaction(messages, {
      keepRecentTokens: 20,
      protectedMessageIndex: 3,
    });

    expect(preparation).toBeDefined();
    expect(preparation!.retainedTail[0]).not.toMatchObject({
      role: "user",
      content: [expect.objectContaining({ type: "tool_result" })],
    });
    expect(
      preparation!.protectedUserMessage === messages[3]
      || preparation!.retainedTail.includes(messages[3]),
    ).toBeTrue();
    expect(preparation!.retainedTail).toContain(messages[4]);
    expect(preparation!.retainedTail).toContain(messages[5]);
  });

  test("serializes thinking, tool arguments, truncated results, and images safely", () => {
    const text = serializeConversation([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect first" },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/app.ts" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read-1", content: "x".repeat(2_500) }],
      },
      { role: "user", content: [{ type: "image", source: { type: "base64", data: "SECRET" } }] },
    ] as any[]);

    expect(text).toContain("inspect first");
    expect(text).toContain('Read({"file_path":"src/app.ts"})');
    expect(text).toContain("500 more characters truncated");
    expect(text).toContain("[Image omitted: image]");
    expect(text).not.toContain("SECRET");
  });

  test("rejects max-token and structurally invalid summaries without replacing history", async () => {
    const messages = [
      { role: "user", content: "old".repeat(20_000) },
      { role: "user", content: "latest" },
    ] as any[];
    const maxed = providerWithSummary(VALID_SUMMARY, "max_tokens");
    const maxedResult = await compactConversation(
      maxed.provider,
      "test-model",
      messages,
      createAutoCompactState(),
      { keepRecentTokens: 1, trigger: "auto" },
    );
    expect(maxedResult).toMatchObject({ compacted: false, failureReason: "max_tokens" });
    expect(maxedResult.compactedMessages).toBe(messages);

    const invalid = providerWithSummary("plain text");
    const invalidResult = await compactConversation(
      invalid.provider,
      "test-model",
      messages,
      createAutoCompactState(),
      { keepRecentTokens: 1, trigger: "manual" },
    );
    expect(invalidResult).toMatchObject({ compacted: false, failureReason: "invalid_structure" });
    expect(invalidResult.compactedMessages).toBe(messages);
  });

  test("uses a previous summary as an incremental checkpoint", async () => {
    const { provider, requests } = providerWithSummary();
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: VALID_SUMMARY, _meta: { contextBlock: "compaction" } }],
      },
      { role: "user", content: "new old work".repeat(5_000) },
      { role: "user", content: "latest request" },
    ] as any[];

    const result = await compactConversation(
      provider,
      "test-model",
      messages,
      createAutoCompactState(),
      { keepRecentTokens: 1, trigger: "manual" },
    );

    expect(result.compacted).toBeTrue();
    expect(requests[0].messages[0].content).toContain("<previous-summary>");
    expect(requests[0].messages[0].content).toContain(VALID_SUMMARY);
    expect(requests[0].messages[0].content).toContain("new old work");
  });

  test("protects the active user request when a huge tool result splits the turn", async () => {
    const { provider } = providerWithSummary(VALID_TURN_PREFIX_SUMMARY);
    const messages = [
      { role: "user", content: "合同审查：内容违规时怎么处理的？" },
      { role: "assistant", content: [{ type: "tool_use", id: "grep-old", name: "Grep", input: { pattern: "违规" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "grep-old", content: "x".repeat(100_000) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "grep-new", name: "Grep", input: { pattern: "内容违规" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "grep-new", content: "current result" }] },
    ] as any[];

    const result = await compactConversation(
      provider,
      "test-model",
      messages,
      createAutoCompactState(),
      { keepRecentTokens: 20, trigger: "prompt_too_long", protectedMessageIndex: 0 },
    );

    expect(result.compacted).toBeTrue();
    expect(result.compactedMessages[1]).toBe(messages[0]);
    expect(result.compactedMessages).toContain(messages[3]);
    expect(result.compactedMessages).toContain(messages[4]);
    expect(JSON.stringify(result.compactedMessages)).not.toContain("x".repeat(5_000));
  });

  test("drops the protected user message from both summarized ranges (#365)", () => {
    const messages = [
      { role: "user", content: "PROTECTED_REQUEST" },
      { role: "assistant", content: [{ type: "tool_use", id: "t-1", name: "Grep", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t-1", content: "r".repeat(8_000) }] },
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "tool_use", id: "t-2", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t-2", content: "current" }] },
    ] as any[];

    const preparation = prepareCompaction(messages, {
      keepRecentTokens: 50,
      protectedMessageIndex: 0,
    });

    expect(preparation).toBeDefined();
    expect(preparation!.isSplitTurn).toBeFalse();
    expect(preparation!.protectedUserMessage).toBe(messages[0]);
    // The message is kept verbatim in the output, so summarizing it too would
    // duplicate it; it must not appear in either serialized range.
    expect(preparation!.messagesToSummarize).not.toContain(messages[0]);
    expect(preparation!.turnPrefixMessages).not.toContain(messages[0]);
    expect(preparation!.retainedTail[0]).toBe(messages[3]);
  });

  test("inserts the protected request exactly once after a split-turn summary (#365)", async () => {
    const MARKER = "PROTECTED_REQUEST_MARKER";
    const { provider, requests } = providerWithSummary(VALID_TURN_PREFIX_SUMMARY);
    const messages = [
      { role: "user", content: `${MARKER} plus background `.repeat(500) },
      { role: "assistant", content: [{ type: "tool_use", id: "g-1", name: "Grep", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "g-1", content: "x".repeat(60_000) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "g-2", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "g-2", content: "current" }] },
    ] as any[];

    const result = await compactConversation(
      provider,
      "test-model",
      messages,
      createAutoCompactState(),
      { keepRecentTokens: 50, trigger: "manual", protectedMessageIndex: 0 },
    );

    expect(result.compacted).toBeTrue();
    expect(result.compactedMessages[1]).toBe(messages[0]);
    // The verbatim copy survives, but the original text must not also be
    // baked into the generated summary.
    expect(JSON.stringify(result.compactedMessages[0])).not.toContain(MARKER);
    const prefixRequest = requests.find((request: any) =>
      String(request.messages[0].content).includes("PREFIX of a turn"));
    expect(prefixRequest).toBeDefined();
    expect(prefixRequest.messages[0].content).not.toContain(MARKER);
  });
});

describe("truncateSerializedConversation (#709 item 6)", () => {
  test("keeps text within budget untouched", () => {
    const text = "[User]: hello world";
    expect(truncateSerializedConversation(text, 10_000)).toBe(text);
  });

  test("truncates middle while preserving head and tail when over budget", () => {
    // ASCII ≈4 chars/token：8_000 字符 ≈ 2_000 tokens，预算 1_000 tokens 必触发
    const head = `[User]: ${"a".repeat(3_900)}`;
    const tail = `[Assistant]: ${"z".repeat(3_900)}`;
    const text = `${head}\n\n${tail}`;
    const truncated = truncateSerializedConversation(text, 1_000);
    expect(truncated.length).toBeLessThan(text.length);
    expect(truncated).toContain("[... ");
    expect(truncated).toContain(" characters truncated ...]");
    expect(truncated.startsWith(`[User]: aaa`)).toBe(true);
    expect(truncated.endsWith("zzz")).toBe(true);
  });
});

describe("microCompactMessages (#364)", () => {
  const budget = 100;

  test("still truncates oversized string tool results", () => {
    const long = "x".repeat(300);
    const [msg] = microCompactMessages(
      [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: long }] }],
      budget,
    );
    const block = msg.content[0];
    expect(block.type).toBe("tool_result");
    expect(block.content.length).toBeLessThan(long.length);
    expect(block.content).toContain("...(truncated)...");
  });

  test("truncates oversized text blocks inside array tool results", () => {
    const long = "y".repeat(300);
    const [msg] = microCompactMessages([
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "t2",
          content: [
            { type: "text", text: long },
            { type: "text", text: "keep me" },
          ],
        }],
      },
    ], budget);
    const content = msg.content[0].content;
    expect(content[0].text.length).toBeLessThan(long.length);
    expect(content[0].text).toContain("...(truncated)...");
    expect(content[1].text).toBe("keep me");
  });

  test("replaces only oversized media blocks; small images stay intact (#364)", () => {
    const imageData = "z".repeat(500);
    const pdfData = "q".repeat(200);
    // Well under the 100-char budget once serialized.
    const smallImage = { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } };
    const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } };
    const docBlock = { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfData } };
    const [msg] = microCompactMessages([
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "t3",
          content: [smallImage, imageBlock, docBlock, { type: "text", text: "short" }],
        }],
      },
    ], budget);

    const content = msg.content[0].content;
    expect(content[0]).toEqual(smallImage);
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("image");
    expect(content[1].text).toContain(String(JSON.stringify(imageBlock).length));
    expect(content[2].type).toBe("text");
    expect(content[2].text).toContain("document");
    // The heavy payloads are gone from the message entirely.
    expect(JSON.stringify(content)).not.toContain(imageData.slice(0, 32));
    expect(JSON.stringify(content)).not.toContain(pdfData.slice(0, 32));
    expect(content[3].text).toBe("short");
  });

  test("leaves messages without oversized tool results untouched in shape", () => {
    const messages = [
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ];
    expect(microCompactMessages(messages, budget)[0]).toBe(messages[0]);
  });
});
