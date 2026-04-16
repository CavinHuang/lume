import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation, listConversations, updateConversationMeta } from "./conversation-manager";

describe("conversation-manager", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-conversation-manager-"));
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

  test("createConversation 应持久化 modelRef", () => {
    const created = createConversation("新对话", "openai/gpt-4.1", "channel-1");

    expect(created.modelRef).toBe("openai/gpt-4.1");
    expect(listConversations()[0]?.modelRef).toBe("openai/gpt-4.1");
  });

  test("updateConversationMeta 应在更新模型时同步 modelRef", () => {
    const created = createConversation("新对话", "gpt-4.1", "channel-1");

    const updated = updateConversationMeta(created.id, {
      channelId: "channel-2",
      modelId: "gpt-5.4"
    });

    expect(updated.modelRef).toBe("channel-2/gpt-5.4");
    expect(listConversations()[0]?.modelRef).toBe("channel-2/gpt-5.4");
  });
});
