import {
  compactConversation,
  estimateMessagesTokens,
  estimateTokens,
  type AutoCompactState,
  type AgentContextController,
  type AgentContextCompactionMetadata
} from "@lume/agent-sdk";
import { stripAfterglowLines } from "@lume/shared";

type KernelMessage = {
  id?: string;
  uuid?: string;
  role: string;
  content?: unknown;
};

export interface ContextBudgetSnapshotInput {
  model: string;
  total: number;
  systemPrompt?: string;
  memoryContext?: string;
  sessionMessages?: KernelMessage[];
  toolSchemaTokens?: number;
  reservedOutputTokens?: number;
}

export interface ContextBudgetSnapshot {
  model: string;
  totalTokens: number;
  usedTokens: number;
  remainingTokens: number;
  sections: {
    system: number;
    memory: number;
    session: number;
    toolSchemas: number;
    reservedOutput: number;
  };
}

export interface KernelContextControllerInput {
  threadId: string;
  model: string;
  contextWindow: number;
  maxOutputTokens?: number;
  systemPrompt: string;
  memoryContext?: string;
  sessionMessages?: KernelMessage[];
  toolSchemaTokens?: number;
}

const DEFAULT_TOOL_RESULT_CHARS = 50_000;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 16_384;
const MAX_RESERVED_OUTPUT_TOKENS = 20_000;
const KERNEL_CONTEXT_POLICY = "kernel-v1";
const KERNEL_CONTEXT_SOURCE = "agent-runtime-kernel";

export function createContextBudgetSnapshot(input: ContextBudgetSnapshotInput): ContextBudgetSnapshot {
  const sessionMessages = input.sessionMessages ?? [];
  const sections = {
    system: estimateTokens(input.systemPrompt ?? ""),
    memory: estimateTokens(input.memoryContext ?? ""),
    session: sessionMessages.length > 0
      ? estimateMessagesTokens(sessionMessages)
      : 0,
    toolSchemas: input.toolSchemaTokens ?? 0,
    reservedOutput: input.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS
  };
  const usedTokens = Object.values(sections).reduce((sum, value) => sum + value, 0);
  return {
    model: input.model,
    totalTokens: input.total,
    usedTokens,
    remainingTokens: Math.max(0, input.total - usedTokens),
    sections
  };
}

export function sanitizeKernelContextMessages<T extends KernelMessage>(messages: T[]): T[] {
  const seenToolUseIds = new Set<string>();
  const sanitized: T[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string") {
          seenToolUseIds.add(block.id);
        }
      }
      if (message.role === "user") {
        const filtered = message.content.filter((block) =>
          !isRecord(block)
          || block.type !== "tool_result"
          || typeof block.tool_use_id !== "string"
          || seenToolUseIds.has(block.tool_use_id)
        );
        if (filtered.length === 0) continue;
        sanitized.push({ ...message, content: filtered });
        continue;
      }
      if (message.role === "assistant") {
        const filtered = message.content.map((block) => {
          if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
          return { ...block, text: stripAfterglowLines(block.text) };
        });
        sanitized.push({ ...message, content: filtered });
        continue;
      }
    }
    sanitized.push(message);
  }
  return sanitized;
}

export function microCompactKernelMessages<T extends KernelMessage>(
  messages: T[],
  options: { maxToolResultChars?: number } = {}
): T[] {
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS;
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (!isRecord(block) || block.type !== "tool_result") return block;
        if (typeof block.content === "string") {
          if (block.content.length <= maxToolResultChars) {
            return block;
          }
          const half = Math.floor(maxToolResultChars / 2);
          return {
            ...block,
            content: `${block.content.slice(0, half)}\n...(truncated by Lume context controller)...\n${block.content.slice(-half)}`
          };
        }
        // #633：数组形 tool_result（如 browser screenshot 的 image block）此前
        // 无界直通 provider、每轮全量重发。与 SDK 默认实现语义对齐：超预算媒体
        // 块 shed 成占位文本，小图保留以免视觉能力回退。
        if (Array.isArray(block.content)) {
          const compacted = compactKernelToolResultContent(block.content, maxToolResultChars);
          return compacted === block.content ? block : { ...block, content: compacted };
        }
        return block;
      })
    };
  });
}

function compactKernelToolResultContent(blocks: unknown[], maxToolResultChars: number): unknown[] {
  let changed = false;
  const next = blocks.map((item) => {
    if (
      isRecord(item)
      && item.type === "text"
      && typeof item.text === "string"
      && item.text.length > maxToolResultChars
    ) {
      changed = true;
      const half = Math.floor(maxToolResultChars / 2);
      return {
        ...item,
        text: `${item.text.slice(0, half)}\n...(truncated by Lume context controller)...\n${item.text.slice(-half)}`
      };
    }
    if (isRecord(item) && (item.type === "image" || item.type === "document")) {
      const originalChars = jsonCharLength(item);
      if (originalChars > maxToolResultChars) {
        changed = true;
        return {
          type: "text",
          text: `[${String(item.type)} omitted by Lume context controller: original ${String(item.type)} was ${originalChars} chars]`
        };
      }
      return item;
    }
    return item;
  });
  return changed ? next : blocks;
}

function jsonCharLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function createKernelContextController(input: KernelContextControllerInput): AgentContextController {
  const sourceMessageIds = extractSourceMessageIds(input.sessionMessages ?? []);
  const preservedSegment = buildPreservedSegment(sourceMessageIds);
  const budget = createContextBudgetSnapshot({
    model: input.model,
    total: input.contextWindow,
    systemPrompt: input.systemPrompt,
    memoryContext: input.memoryContext,
    sessionMessages: input.sessionMessages,
    toolSchemaTokens: input.toolSchemaTokens,
    reservedOutputTokens: input.maxOutputTokens !== undefined
      ? Math.min(Math.max(0, input.maxOutputTokens), MAX_RESERVED_OUTPUT_TOKENS)
      : DEFAULT_RESERVED_OUTPUT_TOKENS
  });
  const metadata = createKernelCompactionMetadata(input.contextWindow, sourceMessageIds, preservedSegment, budget);
  return {
    shouldAutoCompact: ({ messages, model, state, estimatedTokens }) =>
      shouldKernelAutoCompact({
        messages,
        model,
        state,
        estimatedTokens,
        contextWindow: input.contextWindow,
        maxOutputTokens: input.maxOutputTokens,
        budget
      }),
    microCompactMessages: ({ messages }) =>
      microCompactKernelMessages(sanitizeKernelContextMessages(messages)),
    getCompactionMetadata: () => metadata,
    compactConversation: async ({ provider, model, messages, state, trigger, protectedMessageIndex, abortSignal }) => {
      const sanitized = sanitizeKernelContextMessages(messages);
      const sanitizedProtectedMessageIndex = protectedMessageIndex === undefined
        ? undefined
        : sanitizeKernelContextMessages(messages.slice(0, protectedMessageIndex)).length;
      const result = await compactConversation(provider, model, sanitized, state, {
        trigger,
        reserveTokens: budget.sections.reservedOutput,
        protectedMessageIndex: sanitizedProtectedMessageIndex,
        abortSignal
      });
      return {
        ...result,
        metadata: {
          ...metadata,
          outcome: result.compacted ? "succeeded" : "failed",
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
          ...(typeof result.retainedTokens === "number" ? { retainedTokens: result.retainedTokens } : {}),
          ...(typeof result.retainedMessageCount === "number"
            ? { retainedMessageCount: result.retainedMessageCount }
            : {})
        }
      };
    }
  };
}

function shouldKernelAutoCompact(input: {
  messages: KernelMessage[];
  model: string;
  state: AutoCompactState;
  estimatedTokens: number;
  contextWindow: number;
  maxOutputTokens?: number;
  budget: ContextBudgetSnapshot;
}): boolean {
  if (input.state.consecutiveFailures >= 3) return false;
  const reserveTokens = Math.min(
    Math.max(0, input.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS),
    MAX_RESERVED_OUTPUT_TOKENS
  );
  const threshold = Math.max(0, input.contextWindow - reserveTokens);
  const budgetInputTokens = Math.max(0, input.budget.usedTokens - input.budget.sections.reservedOutput);
  const estimatedFullRequestTokens = Math.max(budgetInputTokens, input.estimatedTokens);
  return input.budget.sections.session > 0 && estimatedFullRequestTokens > threshold;
}

function createKernelCompactionMetadata(
  contextWindow: number,
  sourceMessageIds: string[],
  preservedSegment: AgentContextCompactionMetadata["preservedSegment"] | undefined,
  budget: ContextBudgetSnapshot
): AgentContextCompactionMetadata {
  return {
    policy: KERNEL_CONTEXT_POLICY,
    source: KERNEL_CONTEXT_SOURCE,
    contextWindow,
    ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
    ...(preservedSegment ? { preservedSegment } : {}),
    budget
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function extractSourceMessageIds(messages: KernelMessage[]): string[] {
  return messages
    .map((message) => message.id ?? message.uuid)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

function buildPreservedSegment(sourceMessageIds: string[]): AgentContextCompactionMetadata["preservedSegment"] | undefined {
  if (sourceMessageIds.length === 0) return undefined;
  const head = sourceMessageIds[0];
  const tail = sourceMessageIds[sourceMessageIds.length - 1];
  const anchor = sourceMessageIds[Math.floor((sourceMessageIds.length - 1) / 2)];
  return {
    head_uuid: head,
    anchor_uuid: anchor,
    tail_uuid: tail
  };
}
