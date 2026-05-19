import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentSessionPath } from "../../agent/agent-files-service";
import { buildRuntimeUserMessageInput } from "./message-attachment-input";

const originalConfigDir = process.env.LUME_CONFIG_DIR;
const createdDirs: string[] = [];

function createTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lume-runtime-attachments-"));
  createdDirs.push(dir);
  process.env.LUME_CONFIG_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.LUME_CONFIG_DIR = originalConfigDir;
});

describe("message attachment model input", () => {
  test("应将线程图片附件转换为模型 content block", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-images";
    const threadId = "thread-images";
    const sessionDir = getAgentSessionPath(workspaceSlug, threadId);
    writeFileSync(join(sessionDir, "screen.png"), "fake-image");

    const input = buildRuntimeUserMessageInput({
      userMessage: "请解读图片",
      provider: "openai",
      workspaceSlug,
      threadId,
      attachments: [{
        id: "att-1",
        filename: "screen.png",
        mediaType: "image/png",
        size: 10,
        threadPath: "screen.png"
      }]
    });

    expect(input).toEqual([
      { type: "text", text: "请解读图片" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from("fake-image").toString("base64")
        }
      }
    ]);
  });

  test("非图片或不可读取附件应保留文本输入降级", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-text";
    const threadId = "thread-text";
    getAgentSessionPath(workspaceSlug, threadId);

    const input = buildRuntimeUserMessageInput({
      userMessage: "请解读附件",
      provider: "openai",
      workspaceSlug,
      threadId,
      attachments: [
        {
          id: "att-1",
          filename: "brief.md",
          mediaType: "text/markdown",
          size: 3,
          threadPath: "brief.md"
        },
        {
          id: "att-2",
          filename: "missing.png",
          mediaType: "image/png",
          size: 3,
          threadPath: "missing.png"
        }
      ]
    });

    expect(input).toBe("请解读附件");
  });

  test("暂未启用图片 content block 的 provider 应保留文本输入", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-deepseek";
    const threadId = "thread-deepseek";
    const sessionDir = getAgentSessionPath(workspaceSlug, threadId);
    writeFileSync(join(sessionDir, "screen.png"), "fake-image");

    const input = buildRuntimeUserMessageInput({
      userMessage: "请解读图片",
      provider: "deepseek",
      workspaceSlug,
      threadId,
      attachments: [{
        id: "att-1",
        filename: "screen.png",
        mediaType: "image/png",
        size: 10,
        threadPath: "screen.png"
      }]
    });

    expect(input).toBe("请解读图片");
  });
});
