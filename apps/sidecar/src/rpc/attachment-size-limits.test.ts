import { describe, expect, test } from "bun:test";
import { AGENT_ATTACHMENT_LIMITS } from "@lume/shared";
import {
  memoryRememberToolInputSchema,
  saveFilesToThreadInputSchema,
  saveFilesToWorkspaceInputSchema,
  writeBootstrapFileInputSchema
} from "./schemas";

const THREAD_INPUT_BASE = { workspaceSlug: "ws", threadId: "t1" };

function fileWithBase64(bytes: number): string {
  return "a".repeat(bytes);
}

describe("附件与超大字段限额（#154）", () => {
  test("saveFilesToThread 单文件 base64 超 25MB 拒绝", () => {
    const oversized = "a".repeat(Math.ceil(AGENT_ATTACHMENT_LIMITS.maxFileBytes * 4 / 3) + 5);
    const result = saveFilesToThreadInputSchema.safeParse({
      ...THREAD_INPUT_BASE,
      files: [{ filename: "big.bin", data: oversized }]
    });
    expect(result.success).toBeFalse();
  });

  test("saveFilesToThread 批量总量超 50MB 拒绝（单文件均合法）", () => {
    const perFile = Math.ceil(AGENT_ATTACHMENT_LIMITS.maxTotalBytes * 4 / 3 / 3) + 1;
    const files = Array.from({ length: 3 }, (_, index) => ({ filename: `f${index}.bin`, data: fileWithBase64(perFile) }));
    const result = saveFilesToThreadInputSchema.safeParse({ ...THREAD_INPUT_BASE, files });
    expect(result.success).toBeFalse();
  });

  test("saveFilesToWorkspace 对齐限额：单文件上限 + 数量上限 + 总量上限", () => {
    const single = saveFilesToWorkspaceInputSchema.safeParse({
      workspaceSlug: "ws",
      files: [{ filename: "big.bin", data: "a".repeat(Math.ceil(AGENT_ATTACHMENT_LIMITS.maxFileBytes * 4 / 3) + 5) }]
    });
    expect(single.success).toBeFalse();

    const count = saveFilesToWorkspaceInputSchema.safeParse({
      workspaceSlug: "ws",
      files: Array.from({ length: AGENT_ATTACHMENT_LIMITS.maxCount + 1 }, (_, index) => ({ filename: `f${index}`, sourcePath: `/tmp/f${index}` }))
    });
    expect(count.success).toBeFalse();

    const total = saveFilesToWorkspaceInputSchema.safeParse({
      workspaceSlug: "ws",
      files: Array.from({ length: 3 }, (_, index) => ({
        filename: `f${index}.bin`,
        data: "a".repeat(Math.ceil(AGENT_ATTACHMENT_LIMITS.maxTotalBytes * 4 / 3 / 3) + 1)
      }))
    });
    expect(total.success).toBeFalse();
  });

  test("合法批量附件（总量内）通过", () => {
    const result = saveFilesToThreadInputSchema.safeParse({
      ...THREAD_INPUT_BASE,
      files: [
        { filename: "a.txt", data: "aGVsbG8=" },
        { filename: "b.txt", sourcePath: "/tmp/b.txt" }
      ]
    });
    expect(result.success).toBeTrue();
  });

  test("writeBootstrapFile content 超 10MB 拒绝", () => {
    const fileType = "CLAUDE" as const;
    const result = writeBootstrapFileInputSchema.safeParse({
      workspaceSlug: "ws",
      fileType,
      content: "a".repeat(10 * 1024 * 1024 + 1)
    });
    expect(result.success).toBeFalse();
  });

  test("memoryRemember content 超 2MB 拒绝", () => {
    const result = memoryRememberToolInputSchema.safeParse({
      workspaceSlug: "ws",
      content: "a".repeat(2 * 1024 * 1024 + 1)
    });
    expect(result.success).toBeFalse();
  });
});
