
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { AttachmentSaveInput, AttachmentSaveResult } from "@lume/shared";
import { getConversationAttachmentsDir, resolveAttachmentPath } from "../infra/config-paths";

export function saveAttachment(input: AttachmentSaveInput): AttachmentSaveResult {
  const { conversationId, filename, mediaType, data, sourcePath } = input;
  const dir = getConversationAttachmentsDir(conversationId);

  const ext = extname(filename) || ".bin";
  const id = randomUUID();
  const storedFilename = `${id}${ext}`;
  const localPath = `${conversationId}/${storedFilename}`;
  const fullPath = join(dir, storedFilename);

  let size = 0;
  if (sourcePath && sourcePath.trim()) {
    const resolvedSourcePath = resolve(sourcePath);
    const stat = statSync(resolvedSourcePath);
    if (!stat.isFile()) {
      throw new Error(`附件源文件不存在或不可读: ${filename}`);
    }
    copyFileSync(resolvedSourcePath, fullPath);
    size = stat.size;
  } else if (data) {
    const buffer = Buffer.from(data, "base64");
    writeFileSync(fullPath, buffer);
    size = buffer.length;
  } else {
    throw new Error("附件必须提供 data 或 sourcePath");
  }

  return {
    attachment: {
      id,
      filename,
      mediaType,
      localPath,
      size
    }
  };
}

export function readAttachmentAsBase64(localPath: string): string {
  const fullPath = resolveAttachmentPath(localPath);
  return readFileSync(fullPath).toString("base64");
}

export function deleteAttachment(localPath: string): void {
  const fullPath = resolveAttachmentPath(localPath);
  if (existsSync(fullPath)) {
    unlinkSync(fullPath);
  }
}

export function deleteConversationAttachments(conversationId: string): void {
  const dir = getConversationAttachmentsDir(conversationId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function isImageAttachment(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

export function guessMediaTypeByFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}
