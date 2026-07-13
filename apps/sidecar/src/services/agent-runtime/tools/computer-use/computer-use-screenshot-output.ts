import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toThreadRelativePath } from "../../../agent/agent-files-service";
import { getAgentThreadFilesPath } from "../../../infra/config-paths";

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
}

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function saveComputerUseScreenshots(input: {
  workspaceSlug: string;
  threadId: string;
  screenshots: unknown[];
}): SavedComputerUseScreenshot[] {
  const dir = join(getAgentThreadFilesPath(input.workspaceSlug, input.threadId), "computer-use");
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
    const filename = `${capturedAt}-${randomUUID().slice(0, 8)}.${extension}`;
    const absPath = join(dir, filename);
    writeFileSync(absPath, bytes);
    saved.push({
      screenshotId,
      capturedAt,
      threadPath: toThreadRelativePath(input.workspaceSlug, input.threadId, absPath),
      filename,
      mediaType,
      size: bytes.length,
      ...(outputWidth !== undefined ? { width: outputWidth } : {}),
      ...(outputHeight !== undefined ? { height: outputHeight } : {}),
      absPath,
    });
  }

  if (saved.length === 0) throw new Error("screenshot pixels unavailable");
  return saved;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
