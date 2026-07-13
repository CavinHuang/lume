import { describe, expect, test } from "bun:test";
import {
  hydrateEphemeralImageReferences,
  releaseEphemeralImageReferences,
  collectInternalContextBlocks,
  stripInternalContextBlocks,
  renderComputerUseActionFacts,
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
});
