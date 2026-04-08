// TODO: 评估简化版本管理复杂度（当前 20+ 函数），与 UX 需求对齐
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@lume/shared";
import {
  readAgentMessageVersionStore,
  type AgentMessageVersionGroupRecord,
  type AgentMessageVersionRecord,
  type AgentMessageVersionStore,
  writeAgentMessageVersionStore
} from "./agent-message-version-store";

interface CreateUserMessageVersionInput {
  sessionId: string;
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
  sourceMessageId?: string;
}

interface CreateUserMessageVersionResult {
  turnId: string;
  message: AgentMessage;
}

function toAgentMessage(
  record: AgentMessageVersionRecord,
  versionCount: number
): AgentMessage {
  return {
    id: record.messageId,
    role: record.role,
    content: record.content,
    reasoning: record.reasoning,
    createdAt: record.createdAt,
    model: record.model,
    metadata: record.metadata,
    sdkMessages: record.sdkMessages,
    versionGroupId: record.groupId,
    versionIndex: record.versionIndex,
    versionCount,
    supersedesMessageId: record.supersedesMessageId,
    supersededByMessageId: record.supersededByMessageId,
    isLatestVersion: record.isLatestVersion
  };
}

function findGroup(
  store: AgentMessageVersionStore,
  groupId: string
): AgentMessageVersionGroupRecord | undefined {
  return store.groups.find((item) => item.groupId === groupId);
}

function findGroupRecords(
  store: AgentMessageVersionStore,
  groupId: string
): AgentMessageVersionRecord[] {
  const group = findGroup(store, groupId);
  if (!group) {
    return [];
  }
  return group.messageIds
    .map((messageId) => store.messages.find((record) => record.messageId === messageId))
    .filter((record): record is AgentMessageVersionRecord => !!record)
    .sort((a, b) => a.versionIndex - b.versionIndex);
}

function findMessageRecord(
  store: AgentMessageVersionStore,
  messageId: string
): AgentMessageVersionRecord | undefined {
  return store.messages.find((record) => record.messageId === messageId);
}

function getLatestGroupMessage(
  store: AgentMessageVersionStore,
  groupId: string
): AgentMessageVersionRecord | undefined {
  const group = findGroup(store, groupId);
  if (!group) {
    return undefined;
  }
  return findMessageRecord(store, group.latestMessageId)
    ?? findGroupRecords(store, groupId).at(-1);
}

function getVisibleLatestRecords(store: AgentMessageVersionStore): AgentMessageVersionRecord[] {
  return store.visibleGroupIds
    .map((groupId) => getLatestGroupMessage(store, groupId))
    .filter((record): record is AgentMessageVersionRecord => !!record);
}

function reconcileSingleVersionStoreFromTranscript(
  existing: AgentMessageVersionStore,
  transcriptMessages: AgentMessage[]
): AgentMessageVersionStore {
  const nextStore: AgentMessageVersionStore = {
    version: 1,
    sessionId: existing.sessionId,
    groups: [],
    messages: [],
    visibleGroupIds: [],
    updatedAt: Date.now()
  };
  const existingVisibleRecords = getVisibleLatestRecords(existing);
  let currentTurnId: string | null = null;

  for (let index = 0; index < transcriptMessages.length; index++) {
    const message = transcriptMessages[index]!;
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const previousRecord = existingVisibleRecords[index];
    const previousGroup = previousRecord ? findGroup(existing, previousRecord.groupId) : undefined;

    if (message.role === "user" || !currentTurnId) {
      currentTurnId = previousGroup?.turnId ?? createTurnId();
    }

    const groupId = previousGroup?.groupId ?? randomUUID();
    const messageId = previousRecord?.messageId ?? randomUUID();
    const mergedMetadata = {
      ...(previousRecord?.metadata ?? {}),
      ...(message.metadata ?? {})
    };

    nextStore.groups.push({
      groupId,
      turnId: currentTurnId,
      role: message.role,
      latestMessageId: messageId,
      messageIds: [messageId],
      createdAt: message.createdAt,
      updatedAt: message.createdAt
    });
    nextStore.messages.push({
      messageId,
      groupId,
      role: message.role,
      versionIndex: 1,
      isLatestVersion: true,
      createdAt: message.createdAt,
      content: message.content,
      reasoning: message.reasoning,
      model: message.model,
      metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
      sdkMessages: message.sdkMessages
    });
    nextStore.visibleGroupIds.push(groupId);
  }

  writeAgentMessageVersionStore(existing.sessionId, nextStore);
  return nextStore;
}

function findVisibleGroupIndex(
  store: AgentMessageVersionStore,
  groupId: string
): number {
  return store.visibleGroupIds.findIndex((item) => item === groupId);
}

function ensureStore(sessionId: string): AgentMessageVersionStore {
  const store = readAgentMessageVersionStore(sessionId);
  if (!store) {
    throw new Error(`消息版本存储不存在: ${sessionId}`);
  }
  return store;
}

function persistStore(store: AgentMessageVersionStore): AgentMessageVersionStore {
  writeAgentMessageVersionStore(store.sessionId, store);
  return store;
}

function createTurnId(): string {
  return `turn-${randomUUID()}`;
}

function appendGroup(
  store: AgentMessageVersionStore,
  group: AgentMessageVersionGroupRecord,
  record: AgentMessageVersionRecord,
  visibleIndex?: number
): void {
  store.groups.push(group);
  store.messages.push(record);
  if (typeof visibleIndex === "number") {
    store.visibleGroupIds.splice(visibleIndex, 0, group.groupId);
  } else {
    store.visibleGroupIds.push(group.groupId);
  }
}

export function initializeVersionStoreFromMessages(
  sessionId: string,
  transcriptMessages: AgentMessage[]
): AgentMessageVersionStore {
  const groups: AgentMessageVersionGroupRecord[] = [];
  const messages: AgentMessageVersionRecord[] = [];
  const visibleGroupIds: string[] = [];
  let currentTurnId: string | null = null;

  for (const message of transcriptMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (message.role === "user" || !currentTurnId) {
      currentTurnId = createTurnId();
    }

    const groupId = randomUUID();
    const messageId = randomUUID();
    groups.push({
      groupId,
      turnId: currentTurnId,
      role: message.role,
      latestMessageId: messageId,
      messageIds: [messageId],
      createdAt: message.createdAt,
      updatedAt: message.createdAt
    });
    messages.push({
      messageId,
      groupId,
      role: message.role,
      versionIndex: 1,
      isLatestVersion: true,
      createdAt: message.createdAt,
      content: message.content,
      reasoning: message.reasoning,
      model: message.model,
      metadata: message.metadata,
      sdkMessages: message.sdkMessages
    });
    visibleGroupIds.push(groupId);
  }

  const store: AgentMessageVersionStore = {
    version: 1,
    sessionId,
    groups,
    messages,
    visibleGroupIds,
    updatedAt: Date.now()
  };
  writeAgentMessageVersionStore(sessionId, store);
  return store;
}

function matchesVisibleMessages(
  visibleMessages: AgentMessage[],
  transcriptMessages: AgentMessage[]
): boolean {
  if (visibleMessages.length !== transcriptMessages.length) {
    return false;
  }
  for (let index = 0; index < visibleMessages.length; index++) {
    const visible = visibleMessages[index]!;
    const transcript = transcriptMessages[index]!;
    if (
      visible.role !== transcript.role
      || visible.content !== transcript.content
      || visible.reasoning !== transcript.reasoning
      || visible.createdAt !== transcript.createdAt
      || visible.model !== transcript.model
    ) {
      return false;
    }
  }
  return true;
}

export function syncVersionStoreFromMessages(
  sessionId: string,
  transcriptMessages: AgentMessage[]
): AgentMessageVersionStore {
  const existing = readAgentMessageVersionStore(sessionId);
  if (!existing) {
    return initializeVersionStoreFromMessages(sessionId, transcriptMessages);
  }
  const visibleMessages = getVisibleAgentMessages(sessionId);
  if (matchesVisibleMessages(visibleMessages, transcriptMessages)) {
    return existing;
  }
  const hasHistory = existing.groups.some((group) => group.messageIds.length > 1)
    || existing.visibleGroupIds.length !== existing.groups.length;
  if (hasHistory) {
    return existing;
  }
  return reconcileSingleVersionStoreFromTranscript(existing, transcriptMessages);
}

export function getVisibleAgentMessages(sessionId: string): AgentMessage[] {
  const store = readAgentMessageVersionStore(sessionId);
  if (!store) {
    return [];
  }
  return getVisibleLatestRecords(store).map((record) => {
    const records = findGroupRecords(store, record.groupId);
    return toAgentMessage(record, records.length);
  });
}

export function getAgentMessageVersions(sessionId: string, versionGroupId: string): AgentMessage[] {
  const store = readAgentMessageVersionStore(sessionId);
  if (!store) {
    return [];
  }
  const records = findGroupRecords(store, versionGroupId);
  return records.map((record) => toAgentMessage(record, records.length));
}

export function createUserMessageVersion(input: CreateUserMessageVersionInput): CreateUserMessageVersionResult {
  const store = ensureStore(input.sessionId);

  if (!input.sourceMessageId) {
    const turnId = createTurnId();
    const groupId = randomUUID();
    const messageId = randomUUID();
    const group: AgentMessageVersionGroupRecord = {
      groupId,
      turnId,
      role: "user",
      latestMessageId: messageId,
      messageIds: [messageId],
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    };
    const record: AgentMessageVersionRecord = {
      messageId,
      groupId,
      role: "user",
      versionIndex: 1,
      isLatestVersion: true,
      createdAt: input.createdAt,
      content: input.content,
      metadata: input.metadata
    };
    appendGroup(store, group, record);
    persistStore(store);
    return {
      turnId,
      message: toAgentMessage(record, 1)
    };
  }

  const sourceRecord = findMessageRecord(store, input.sourceMessageId);
  if (!sourceRecord || sourceRecord.role !== "user") {
    throw new Error(`无效的重发目标消息: ${input.sourceMessageId}`);
  }
  const group = findGroup(store, sourceRecord.groupId);
  if (!group) {
    throw new Error(`找不到目标消息组: ${sourceRecord.groupId}`);
  }
  const latestRecord = getLatestGroupMessage(store, group.groupId);
  if (!latestRecord) {
    throw new Error(`找不到目标消息最新版本: ${group.groupId}`);
  }
  latestRecord.isLatestVersion = false;
  latestRecord.supersededByMessageId = "";

  const visibleIndex = findVisibleGroupIndex(store, group.groupId);
  if (visibleIndex === -1) {
    throw new Error(`目标消息不在当前可见链中: ${input.sourceMessageId}`);
  }

  const messageId = randomUUID();
  latestRecord.supersededByMessageId = messageId;
  const nextRecord: AgentMessageVersionRecord = {
    messageId,
    groupId: group.groupId,
    role: "user",
    versionIndex: latestRecord.versionIndex + 1,
    supersedesMessageId: latestRecord.messageId,
    isLatestVersion: true,
    createdAt: input.createdAt,
    content: input.content,
    metadata: input.metadata
  };
  store.messages.push(nextRecord);
  group.latestMessageId = messageId;
  group.messageIds.push(messageId);
  group.updatedAt = input.createdAt;
  store.visibleGroupIds = [...store.visibleGroupIds.slice(0, visibleIndex), group.groupId];

  persistStore(store);
  const records = findGroupRecords(store, group.groupId);
  return {
    turnId: group.turnId,
    message: toAgentMessage(nextRecord, records.length)
  };
}

export function createAssistantMessageVersion(params: {
  sessionId: string;
  turnId: string;
  message: AgentMessage;
}): AgentMessage | null {
  if (params.message.role !== "assistant") {
    return null;
  }
  const store = ensureStore(params.sessionId);
  let group = store.groups.find((item) => item.turnId === params.turnId && item.role === "assistant");

  if (!group) {
    const groupId = randomUUID();
    const messageId = randomUUID();
    group = {
      groupId,
      turnId: params.turnId,
      role: "assistant",
      latestMessageId: messageId,
      messageIds: [messageId],
      createdAt: params.message.createdAt,
      updatedAt: params.message.createdAt
    };
    const record: AgentMessageVersionRecord = {
      messageId,
      groupId,
      role: "assistant",
      versionIndex: 1,
      isLatestVersion: true,
      createdAt: params.message.createdAt,
      content: params.message.content,
      reasoning: params.message.reasoning,
      model: params.message.model,
      metadata: params.message.metadata,
      sdkMessages: params.message.sdkMessages
    };
    const userGroupIndex = store.visibleGroupIds.findIndex((groupIdItem) => {
      const visibleGroup = findGroup(store, groupIdItem);
      return visibleGroup?.turnId === params.turnId && visibleGroup.role === "user";
    });
    appendGroup(store, group, record, userGroupIndex === -1 ? undefined : userGroupIndex + 1);
    persistStore(store);
    return toAgentMessage(record, 1);
  }

  const latestRecord = getLatestGroupMessage(store, group.groupId);
  if (latestRecord) {
    latestRecord.isLatestVersion = false;
  }
  const messageId = randomUUID();
  if (latestRecord) {
    latestRecord.supersededByMessageId = messageId;
  }
  const nextRecord: AgentMessageVersionRecord = {
    messageId,
    groupId: group.groupId,
    role: "assistant",
    versionIndex: (latestRecord?.versionIndex ?? 0) + 1,
    supersedesMessageId: latestRecord?.messageId,
    isLatestVersion: true,
    createdAt: params.message.createdAt,
    content: params.message.content,
    reasoning: params.message.reasoning,
    model: params.message.model,
    metadata: params.message.metadata,
    sdkMessages: params.message.sdkMessages
  };
  store.messages.push(nextRecord);
  group.latestMessageId = messageId;
  group.messageIds.push(messageId);
  group.updatedAt = params.message.createdAt;
  if (!store.visibleGroupIds.includes(group.groupId)) {
    const userGroupIndex = store.visibleGroupIds.findIndex((groupIdItem) => {
      const visibleGroup = findGroup(store, groupIdItem);
      return visibleGroup?.turnId === params.turnId && visibleGroup.role === "user";
    });
    store.visibleGroupIds.splice(userGroupIndex === -1 ? store.visibleGroupIds.length : userGroupIndex + 1, 0, group.groupId);
  }
  persistStore(store);
  const records = findGroupRecords(store, group.groupId);
  return toAgentMessage(nextRecord, records.length);
}

export function getLatestVisibleMessagesForSession(sessionId: string): AgentMessage[] {
  return getVisibleAgentMessages(sessionId);
}

export function getVisibleTurnIdForMessage(sessionId: string, messageId: string): string | null {
  const store = readAgentMessageVersionStore(sessionId);
  if (!store) {
    return null;
  }
  const record = findMessageRecord(store, messageId);
  if (!record) {
    return null;
  }
  const group = findGroup(store, record.groupId);
  return group?.turnId ?? null;
}
