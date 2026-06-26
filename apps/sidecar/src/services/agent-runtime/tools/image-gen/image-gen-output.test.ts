import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveImageOutput } from "./image-gen-output";

const originalFetch = globalThis.fetch;
let prevConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  prevConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-img-out-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = prevConfigDir;
  if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
});

describe("image-gen-output", () => {
  test("b64 解码后写入线程 files/image-gen 目录，返回相对线程根的 threadPath", async () => {
    const result = await saveImageOutput({
      workspaceSlug: "ws",
      threadId: "thread-1",
      b64: Buffer.from("fake-png-bytes").toString("base64"),
      ext: "png",
    });

    expect(result.threadPath).toMatch(/^files\/image-gen\/.+\.png$/);
    expect(result.mediaType).toBe("image/png");
    expect(result.size).toBeGreaterThan(0);
    expect(existsSync(result.absPath)).toBe(true);
    expect(readFileSync(result.absPath).toString()).toBe("fake-png-bytes");
  });

  test("url 下载后写入文件", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 })) as unknown as typeof fetch;

    const result = await saveImageOutput({
      workspaceSlug: "ws",
      threadId: "thread-2",
      url: "https://example.com/x.png",
    });

    expect(result.threadPath).toMatch(/^files\/image-gen\/.+\.png$/);
    expect(result.size).toBe(4);
  });

  test("缺少 url 与 b64 抛错", async () => {
    await expect(
      saveImageOutput({ workspaceSlug: "ws", threadId: "thread-3" }),
    ).rejects.toThrow(/缺少图片数据/);
  });

  test("jpg 扩展名映射为 image/jpeg", async () => {
    const result = await saveImageOutput({
      workspaceSlug: "ws",
      threadId: "thread-4",
      b64: Buffer.from("x").toString("base64"),
      ext: "jpg",
    });
    expect(result.mediaType).toBe("image/jpeg");
  });
});
