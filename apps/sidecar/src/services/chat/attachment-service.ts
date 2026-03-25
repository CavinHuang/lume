/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\attachment-service.ts
 * Adaptation:
 * - Sidecar-only filesystem helper subset for MIG-004.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { AttachmentSaveInput, AttachmentSaveResult } from "@lume/shared";
import { getConversationAttachmentsDir, resolveAttachmentPath } from "../config-paths";

export function saveAttachment(input: AttachmentSaveInput): AttachmentSaveResult {
  const { conversationId, filename, mediaType, data } = input;
  const dir = getConversationAttachmentsDir(conversationId);

  const ext = extname(filename) || ".bin";
  const id = randomUUID();
  const storedFilename = `${id}${ext}`;
  const localPath = `${conversationId}/${storedFilename}`;
  const fullPath = join(dir, storedFilename);

  const buffer = Buffer.from(data, "base64");
  writeFileSync(fullPath, buffer);

  return {
    attachment: {
      id,
      filename,
      mediaType,
      localPath,
      size: buffer.length
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
