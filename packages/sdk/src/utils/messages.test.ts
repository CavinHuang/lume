import { describe, expect, test } from "bun:test";
import {
  hydrateEphemeralImageReferences,
  releaseEphemeralImageReferences,
  collectInternalContextBlocks,
  stripInternalContextBlocks,
  renderComputerUseActionFacts,
  normalizeComputerUseActionFact,
  projectPersistedToolResultMeta,
} from "./messages.js";

describe("ephemeral image references", () => {
  test("hydrates nested tool_result images for one request and then releases them", async () => {
    const messages = [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "shot-1",
        content: [{
          type: "image",
          source: { type: "file", path: "C:/thread/shot.png", media_type: "image/png" },
          _meta: { persist: false, ephemeral: "trusted_runtime" },
        }],
      }],
    }];
    const hydrated = await hydrateEphemeralImageReferences(messages, async () => Buffer.from("png"));
    expect((hydrated[0]!.content as any[])[0].content[0].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
    expect(JSON.stringify(messages)).not.toContain(Buffer.from("png").toString("base64"));

    const released = releaseEphemeralImageReferences(messages);
    expect(JSON.stringify(released)).toContain("Screenshot reference: C:/thread/shot.png");
    expect(JSON.stringify(released)).not.toContain('"type":"image"');
  });

  test("does not hydrate untrusted file-shaped image blocks", async () => {
    let reads = 0;
    const messages = [{ role: "user", content: [{
      type: "image",
      source: { type: "file", path: "C:/secret.txt", media_type: "image/png" },
    }] }];
    const hydrated = await hydrateEphemeralImageReferences(messages, async () => {
      reads += 1;
      return Buffer.from("secret");
    });
    expect(reads).toBe(0);
    expect(hydrated).toEqual(messages);
  });

  test("releases fallback visual observations after one provider request", () => {
    const messages = [{ role: "user", content: [{
      type: "text",
      text: "[Untrusted visual observation]\nsecret visible text",
      _meta: { contextBlock: "computer_use_visual", persist: false, screenshotId: "shot-1" },
    }] }];
    const released = releaseEphemeralImageReferences(messages);
    expect(JSON.stringify(released)).not.toContain("secret visible text");
    expect(JSON.stringify(released)).toContain("shot-1");
  });

  test("keeps compaction facts in an internal context block outside provider messages", () => {
    const messages = [{ role: "user", content: [
      { type: "text", text: "内部摘要", _meta: { contextBlock: "compaction" } },
      { type: "text", text: "普通消息" },
    ] }];
    expect(collectInternalContextBlocks(messages)).toEqual(["内部摘要"]);
    expect(stripInternalContextBlocks(messages)).toEqual([{
      role: "user",
      content: [{ type: "text", text: "普通消息" }],
    }]);
  });

  test("renders action completion only from immutable tool metadata", () => {
    const messages = [{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "action",
      content: '{"status":"dispatched"}',
      _meta: { computerUseAction: {
        actionId: "action-1",
        action: "type_text",
        phase: "verified",
        window: { id: 42, app: "微信" },
      } },
    }] }];
    expect(renderComputerUseActionFacts(messages)).toContain(
      "action-1: type_text on 微信#42; phase=verified; verified complete",
    );
  });

  test("renders every action advanced by one batched observation", () => {
    const messages = [{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "observe",
      content: "{}",
      _meta: { computerUseActions: [
        { actionId: "action-1", action: "click", phase: "observed", window: { id: 42, app: "微信" } },
        { actionId: "action-2", action: "type_text", phase: "verified", window: { id: 42, app: "微信" } },
      ] },
    }] }];
    const facts = renderComputerUseActionFacts(messages);
    expect(facts).toContain("action-1: click on 微信#42; phase=observed; not verified complete");
    expect(facts).toContain("action-2: type_text on 微信#42; phase=verified; verified complete");
  });

  test("drops facts with unknown phase or missing identity (#709 item 2)", () => {
    expect(normalizeComputerUseActionFact({ actionId: "a", action: "click", phase: "garbage" })).toBeNull();
    expect(normalizeComputerUseActionFact({ actionId: "a", phase: "verified" })).toBeNull();
    expect(normalizeComputerUseActionFact({ action: "click", phase: "verified" })).toBeNull();
    const messages = [{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "x",
      content: "{}",
      _meta: { computerUseAction: { actionId: "action-1", action: "click", phase: "not-a-phase", window: { app: "App" } } },
    }] }];
    expect(renderComputerUseActionFacts(messages)).toBe("");
  });

  test("mixed batch: valid entries survive, invalid ones dropped (#725 review R9)", () => {
    const messages = [{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "observe",
      content: "{}",
      _meta: { computerUseActions: [
        { actionId: "action-1", action: "click", phase: "verified", window: { id: 1, app: "IDE" } },
        { actionId: "action-2", action: "type_text", phase: "bogus", window: { id: 1, app: "IDE" } },
      ] },
    }] }];
    const facts = renderComputerUseActionFacts(messages);
    expect(facts).toContain("action-1");
    expect(facts).not.toContain("action-2");
  });

  test("caps oversized string fields and drops unknown fields (#709 item 2)", () => {
    const fact = normalizeComputerUseActionFact({
      actionId: "a".repeat(200),
      action: "click",
      phase: "verified",
      window: { id: 1, app: "W".repeat(200) },
      screenshotId: "shot-9",
      failureReason: "whatever",
    });
    expect(fact).toEqual({
      actionId: "a".repeat(64),
      action: "click",
      phase: "verified",
      window: { id: 1, app: "W".repeat(80) },
    });
  });
});

describe("projectPersistedToolResultMeta (#709 items 1+2)", () => {
  test("keeps only validated computerUseAction and string toolName", () => {
    const meta = projectPersistedToolResultMeta({
      computerUseAction: { actionId: "action-1", action: "click", phase: "verified", window: { id: 7, app: "IDE" }, screenshotId: "s1" },
      toolName: "mcp__cu__click",
      error: { code: "permission_denied", retryable: false },
      ephemeral: "trusted_runtime",
    });
    expect(meta).toEqual({
      computerUseAction: { actionId: "action-1", action: "click", phase: "verified", window: { id: 7, app: "IDE" } },
      toolName: "mcp__cu__click",
    });
  });

  test("returns undefined for empty/invalid meta", () => {
    expect(projectPersistedToolResultMeta(undefined)).toBeUndefined();
    expect(projectPersistedToolResultMeta({})).toBeUndefined();
    expect(projectPersistedToolResultMeta({ computerUseAction: { phase: "bogus" } })).toBeUndefined();
  });
});
