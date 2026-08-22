import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toThreadRelativePath } from "../../../agent/agent-files-service";
import { resolveAgentThreadWorkdir } from "../../../agent/agent-workdir-resolver";
import { getAgentThreadFilesPath } from "../../../infra/config-paths";
import type { FileRef } from "@lume/shared";

export interface SavedComputerUseScreenshot {
  screenshotId: string;
  capturedAt: number;
  threadPath: string;
  filename: string;
  mediaType: string;
  size: number;
  width?: number;
  height?: number;
  absPath: string;
  fileRef?: FileRef;
}

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function saveComputerUseScreenshots(input: {
  workspaceSlug?: string;
  threadId: string;
  filesRoot?: string;
  screenshots: unknown[];
}): SavedComputerUseScreenshot[] {
  const filesRoot = input.filesRoot ?? resolveFilesRoot(input.workspaceSlug, input.threadId);
  const dir = join(filesRoot, "computer-use");
  const saved: SavedComputerUseScreenshot[] = [];

  for (const candidate of input.screenshots) {
    const screenshot = asRecord(candidate);
    const url = typeof screenshot.url === "string" ? screenshot.url : "";
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    const mediaType = match?.[1] ?? "";
    const extension = EXTENSION_BY_MEDIA_TYPE[mediaType];
    if (!extension) throw new Error(`unsupported screenshot media type: ${mediaType || "unknown"}`);
    const bytes: Buffer<ArrayBufferLike> = Buffer.from(match?.[2] ?? "", "base64");
    if (bytes.length === 0) throw new Error("screenshot pixels unavailable");
    const outputWidth = typeof screenshot.width === "number" ? screenshot.width : undefined;
    const outputHeight = typeof screenshot.height === "number" ? screenshot.height : undefined;
    mkdirSync(dir, { recursive: true });
    const capturedAt = Date.now();
    const hostScreenshotId = typeof screenshot.id === "string" ? screenshot.id : "";
    const screenshotId = hostScreenshotId || `screenshot:${randomUUID()}`;
    // 文件名=内容 hash(#257):同页面重复截图天然复用同一文件,不再每轮落一份相同二进制
    const filename = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${extension}`;
    const absPath = join(dir, filename);
    if (!existsSync(absPath)) {
      writeFileSync(absPath, bytes);
    }
    const threadPath = toThreadRelativePath(input.workspaceSlug, input.threadId, absPath);
    let fileRef: FileRef | undefined;
    try {
      fileRef = {
        source: "session",
        scopeId: resolveAgentThreadWorkdir(input.threadId).fileContextId,
        relativePath: threadPath,
      };
    } catch {
      // Legacy/headless callers retain threadPath for authorized conversion.
    }
    saved.push({
      screenshotId,
      capturedAt,
      threadPath,
      filename,
      mediaType,
      size: bytes.length,
      ...(outputWidth !== undefined ? { width: outputWidth } : {}),
      ...(outputHeight !== undefined ? { height: outputHeight } : {}),
      absPath,
      ...(fileRef ? { fileRef } : {}),
    });
  }

  if (saved.length === 0) throw new Error("screenshot pixels unavailable");
  return saved;
}

function resolveFilesRoot(workspaceSlug: string | undefined, threadId: string): string {
  try {
    return resolveAgentThreadWorkdir(threadId).filesRoot;
  } catch {
    if (!workspaceSlug) {
      throw new Error("无法解析普通会话文件目录");
    }
    return getAgentThreadFilesPath(workspaceSlug, threadId);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
