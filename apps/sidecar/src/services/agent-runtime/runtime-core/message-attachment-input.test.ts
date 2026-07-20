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
      visionSupported: true,
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

  test("合并桌面视觉块和普通图片附件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-desktop-image";
    const threadId = "thread-desktop-image";
    const sessionDir = getAgentSessionPath(workspaceSlug, threadId);
    writeFileSync(join(sessionDir, "screen.png"), "fake-image");

    const input = buildRuntimeUserMessageInput({
      userMessage: "请根据当前微信回复",
      visionSupported: true,
      workspaceSlug,
      threadId,
      contentBlocks: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "desktop-shot" },
        _meta: { screenshotId: "shot-1", persist: false },
      }],
      attachments: [{
        id: "att-1",
        filename: "screen.png",
        mediaType: "image/png",
        size: 10,
        threadPath: "screen.png"
      }]
    });

    expect(input).toEqual([
      { type: "text", text: "请根据当前微信回复" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "desktop-shot" },
        _meta: { screenshotId: "shot-1", persist: false },
      },
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

  test("非图片附件保留文本输入并由文件工具按需读取", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-text";
    const threadId = "thread-text";
    getAgentSessionPath(workspaceSlug, threadId);

    const input = buildRuntimeUserMessageInput({
      userMessage: "请解读附件",
      visionSupported: true,
      workspaceSlug,
      threadId,
      attachments: [
        {
          id: "att-1",
          filename: "brief.md",
          mediaType: "text/markdown",
          size: 3,
          threadPath: "brief.md"
        }
      ]
    });

    expect(input).toBe("请解读附件");
  });

  test("不可读取图片应明确失败而不是静默跳过", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-missing-image";
    const threadId = "thread-missing-image";
    getAgentSessionPath(workspaceSlug, threadId);

    expect(() => buildRuntimeUserMessageInput({
      userMessage: "请解读图片",
      visionSupported: true,
      workspaceSlug,
      threadId,
      attachments: [{
        id: "att-missing",
        filename: "missing.png",
        mediaType: "image/png",
        size: 3,
        threadPath: "missing.png"
      }]
    })).toThrow("图片附件不可读取");
  });

  test("不支持视觉的模型应在运行前明确拒绝图片", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-deepseek";
    const threadId = "thread-deepseek";
    const sessionDir = getAgentSessionPath(workspaceSlug, threadId);
    writeFileSync(join(sessionDir, "screen.png"), "fake-image");

    expect(() => buildRuntimeUserMessageInput({
      userMessage: "请解读图片",
      visionSupported: false,
      workspaceSlug,
      threadId,
      attachments: [{
        id: "att-1",
        filename: "screen.png",
        mediaType: "image/png",
        size: 10,
        threadPath: "screen.png"
      }]
    })).toThrow("当前模型不支持图片输入");
  });
});
