/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\conversation-manager.ts
 * Adaptation:
 * - Shared imports updated to `@lume/shared`.
 * - Attachment hooks mapped to sidecar attachment helpers.
 */

import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ConversationMeta, RecentMessagesResult } from "@lume/shared";
import { deleteAttachment, deleteConversationAttachments } from "./attachment-service";
import { getConversationMessagesPath, getConversationsDir, getConversationsIndexPath } from "./config-paths";

interface ConversationsIndex {
  version: number;
  conversations: ConversationMeta[];
}

const INDEX_VERSION = 1;

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

function writeIndex(index: ConversationsIndex): void {
  writeFileSync(getConversationsIndexPath(), JSON.stringify(index, null, 2), "utf-8");
}

export function listConversations(): ConversationMeta[] {
  return readIndex().conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createConversation(title?: string, modelId?: string, channelId?: string): ConversationMeta {
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
    return { messages: [], total: 0, hasMore: false };
  }
}

export function appendMessage(id: string, message: ChatMessage): void {
  appendFileSync(getConversationMessagesPath(id), `${JSON.stringify(message)}\n`, "utf-8");
}

export function saveConversationMessages(id: string, messages: ChatMessage[]): void {
  const content = messages.map((msg) => JSON.stringify(msg)).join("\n") + (messages.length > 0 ? "\n" : "");
  writeFileSync(getConversationMessagesPath(id), content, "utf-8");
}

export function updateConversationMeta(
  id: string,
  updates: Partial<Pick<ConversationMeta, "title" | "modelId" | "channelId" | "contextDividers" | "contextLength" | "pinned">>
): ConversationMeta {
  const index = readIndex();
  const idx = index.conversations.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`对话不存在: ${id}`);
  const existing = index.conversations[idx] as ConversationMeta;
  const updated: ConversationMeta = { ...existing, ...updates, updatedAt: Date.now() };
  index.conversations[idx] = updated;
  writeIndex(index);
  return updated;
}

export function deleteConversation(id: string): void {
  const index = readIndex();
  const idx = index.conversations.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`对话不存在: ${id}`);
  index.conversations.splice(idx, 1);
  writeIndex(index);
  const filePath = getConversationMessagesPath(id);
  if (existsSync(filePath)) unlinkSync(filePath);
  deleteConversationAttachments(id);
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
  return kept;
}

export function updateContextDividers(conversationId: string, dividers: string[]): ConversationMeta {
  return updateConversationMeta(conversationId, { contextDividers: dividers });
}
