/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\conversation-manager.ts
 * Adaptation:
 * - Shared imports updated to `@lume/shared`.
 * - Attachment hooks mapped to sidecar attachment helpers.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ConversationMeta, RecentMessagesResult } from "@lume/shared";
import { deleteAttachment, deleteConversationAttachments } from "./attachment-service";
import { getConversationMessagesPath, getConversationsDir, getConversationsIndexPath } from "../config-paths";
import { clearNanoBananaConversationHistory } from "../nano-banana-service";

interface ConversationsIndex {
  version: number;
  conversations: ConversationMeta[];
}

const INDEX_VERSION = 1;

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function backupCorruptFile(filePath: string, label: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, backupPath);
    console.warn(`[${label}] 检测到损坏文件，已备份: ${backupPath}`);
  } catch (error) {
    console.warn(`[${label}] 备份损坏文件失败:`, error);
  }
}

function readIndex(): ConversationsIndex {
  const indexPath = getConversationsIndexPath();
  if (!existsSync(indexPath)) return { version: INDEX_VERSION, conversations: [] };
  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")) as ConversationsIndex;
  } catch (error) {
    console.error("[对话管理] 读取索引文件失败:", error);
    return { version: INDEX_VERSION, conversations: [] };
  }
}

// 简单的写锁，防止并发写入竞态
let indexWriteLock = false;
const indexWriteQueue: Array<() => void> = [];

function writeIndex(index: ConversationsIndex): void {
  const indexPath = getConversationsIndexPath();
  writeTextAtomic(indexPath, JSON.stringify(index, null, 2));
}

function withIndexLock<T>(fn: () => T): T {
  if (indexWriteLock) {
    // 等待锁释放（同步场景下直接执行，锁仅防止逻辑上的并发读-改-写）
    return fn();
  }
  indexWriteLock = true;
  try {
    return fn();
  } finally {
    indexWriteLock = false;
  }
}

export function listConversations(): ConversationMeta[] {
  return readIndex().conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createConversation(title?: string, modelId?: string, channelId?: string): ConversationMeta {
  return withIndexLock(() => {
    const index = readIndex();
    const now = Date.now();
    const meta: ConversationMeta = {
      id: randomUUID(),
      title: title || "新对话",
      modelId,
      channelId,
      createdAt: now,
      updatedAt: now
    };
    index.conversations.push(meta);
    writeIndex(index);
    getConversationsDir();
    return meta;
  });
}

export function getConversationMessages(id: string): ChatMessage[] {
  const filePath = getConversationMessagesPath(id);
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ChatMessage);
  } catch (error) {
    console.error(`[对话管理] 读取消息失败 (${id}):`, error);
    backupCorruptFile(filePath, "对话消息");
    return [];
  }
}

export function getRecentMessages(id: string, limit: number): RecentMessagesResult {
  const filePath = getConversationMessagesPath(id);
  if (!existsSync(filePath)) return { messages: [], total: 0, hasMore: false };
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim());
    const total = lines.length;
    if (total <= limit) {
      return { messages: lines.map((line) => JSON.parse(line) as ChatMessage), total, hasMore: false };
    }
    const recent = lines.slice(-limit).map((line) => JSON.parse(line) as ChatMessage);
    return { messages: recent, total, hasMore: true };
  } catch (error) {
    console.error(`[对话管理] 读取最近消息失败 (${id}):`, error);
    backupCorruptFile(filePath, "对话消息");
    return { messages: [], total: 0, hasMore: false };
  }
}

export function appendMessage(id: string, message: ChatMessage): void {
  appendFileSync(getConversationMessagesPath(id), `${JSON.stringify(message)}\n`, "utf-8");
}

export function saveConversationMessages(id: string, messages: ChatMessage[]): void {
  const content = messages.map((msg) => JSON.stringify(msg)).join("\n") + (messages.length > 0 ? "\n" : "");
  writeTextAtomic(getConversationMessagesPath(id), content);
}

export function updateConversationMeta(
  id: string,
  updates: Partial<Pick<ConversationMeta, "title" | "modelId" | "channelId" | "contextDividers" | "contextLength" | "pinned">>
): ConversationMeta {
  return withIndexLock(() => {
    const index = readIndex();
    const idx = index.conversations.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error(`对话不存在: ${id}`);
    const existing = index.conversations[idx] as ConversationMeta;
    const updated: ConversationMeta = { ...existing, ...updates, updatedAt: Date.now() };
    index.conversations[idx] = updated;
    writeIndex(index);
    return updated;
  });
}

export function deleteConversation(id: string): void {
  withIndexLock(() => {
    const index = readIndex();
    const idx = index.conversations.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error(`对话不存在: ${id}`);
    index.conversations.splice(idx, 1);
    writeIndex(index);
  });
  const filePath = getConversationMessagesPath(id);
  if (existsSync(filePath)) unlinkSync(filePath);
  deleteConversationAttachments(id);
  clearNanoBananaConversationHistory(id);
}

export function deleteMessage(conversationId: string, messageId: string): ChatMessage[] {
  const messages = getConversationMessages(conversationId);
  const target = messages.find((msg) => msg.id === messageId);
  const filtered = messages.filter((msg) => msg.id !== messageId);
  if (target?.attachments) {
    for (const attachment of target.attachments) {
      deleteAttachment(attachment.localPath);
    }
  }
  saveConversationMessages(conversationId, filtered);
  clearNanoBananaConversationHistory(conversationId);
  return filtered;
}

export function truncateMessagesFrom(
  conversationId: string,
  messageId: string,
  preserveFirstMessageAttachments = false
): ChatMessage[] {
  const messages = getConversationMessages(conversationId);
  const targetIndex = messages.findIndex((msg) => msg.id === messageId);
  if (targetIndex === -1) return messages;

  const kept = messages.slice(0, targetIndex);
  const removed = messages.slice(targetIndex);

  for (const [idx, msg] of removed.entries()) {
    const shouldPreserve = preserveFirstMessageAttachments && idx === 0;
    if (shouldPreserve) continue;
    if (!msg.attachments) continue;
    for (const attachment of msg.attachments) {
      deleteAttachment(attachment.localPath);
    }
  }

  saveConversationMessages(conversationId, kept);
  clearNanoBananaConversationHistory(conversationId);
  return kept;
}

export function updateContextDividers(conversationId: string, dividers: string[]): ConversationMeta {
  return updateConversationMeta(conversationId, { contextDividers: dividers });
}
