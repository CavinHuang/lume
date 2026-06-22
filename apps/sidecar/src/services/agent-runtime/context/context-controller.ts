import {
  calculateAutoCompactThreshold,
  compactConversation,
  estimateMessagesTokens,
  estimateTokens,
  shouldAutoCompact,
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
    reservedOutput: input.reservedOutputTokens ?? Math.floor(input.total * 0.05)
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
        if (!isRecord(block) || block.type !== "tool_result" || typeof block.content !== "string") {
          return block;
        }
        if (block.content.length <= maxToolResultChars) {
          return block;
        }
        const half = Math.floor(maxToolResultChars / 2);
        return {
          ...block,
          content: `${block.content.slice(0, half)}\n...(truncated by Lume context controller)...\n${block.content.slice(-half)}`
        };
      })
    };
  });
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
      ? Math.min(Math.max(0, input.maxOutputTokens), 20_000)
      : undefined
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
    compactConversation: async ({ provider, model, messages, state }) => {
      const sanitized = microCompactKernelMessages(sanitizeKernelContextMessages(messages));
      const result = await compactConversation(provider, model, sanitized, state);
      return {
        ...result,
        metadata
      };
    }
  };
}

function shouldKernelAutoCompact(input: {
  messages: KernelMessage[];
  model: string;
  state: Parameters<typeof shouldAutoCompact>[2];
  estimatedTokens: number;
  contextWindow: number;
  maxOutputTokens?: number;
  budget: ContextBudgetSnapshot;
}): boolean {
  if (input.state.consecutiveFailures >= 3) return false;
  const sdkHistoryTriggers = shouldAutoCompact(input.messages, input.model, input.state);
  if (sdkHistoryTriggers) return true;

  const threshold = calculateAutoCompactThreshold(input.contextWindow, input.maxOutputTokens);
  const nonSessionBudgetTokens = Math.max(0, input.budget.usedTokens - input.budget.sections.session);
  const estimatedFullRequestTokens =
    nonSessionBudgetTokens + Math.max(input.budget.sections.session, input.estimatedTokens);
  return input.budget.sections.session > 0 && estimatedFullRequestTokens >= threshold;
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
