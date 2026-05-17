import {
  compactConversation,
  shouldAutoCompact,
  type AgentContextController,
  type AgentContextCompactionMetadata
} from "@lume/agent-sdk";

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
  systemPrompt: string;
  memoryContext?: string;
  sessionMessages?: KernelMessage[];
  toolSchemaTokens?: number;
}

const DEFAULT_TOOL_RESULT_CHARS = 50_000;
const KERNEL_CONTEXT_POLICY = "kernel-v1";
const KERNEL_CONTEXT_SOURCE = "agent-runtime-kernel";

export function createContextBudgetSnapshot(input: ContextBudgetSnapshotInput): ContextBudgetSnapshot {
  const sections = {
    system: estimateTokens(input.systemPrompt ?? ""),
    memory: estimateTokens(input.memoryContext ?? ""),
    session: estimateTokens(JSON.stringify(input.sessionMessages ?? [])),
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
    toolSchemaTokens: input.toolSchemaTokens
  });
  return {
    shouldAutoCompact: ({ messages, model, state, estimatedTokens }) =>
      shouldAutoCompact(messages, model, state) || estimatedTokens >= Math.floor(input.contextWindow * 0.85),
    microCompactMessages: ({ messages }) =>
      microCompactKernelMessages(sanitizeKernelContextMessages(messages)),
    compactConversation: async ({ provider, model, messages, state }) => {
      const sanitized = microCompactKernelMessages(sanitizeKernelContextMessages(messages));
      const result = await compactConversation(provider, model, sanitized, state);
      return {
        ...result,
        metadata: {
          policy: KERNEL_CONTEXT_POLICY,
          source: KERNEL_CONTEXT_SOURCE,
          contextWindow: input.contextWindow,
          memoryFlushJobId: `memory.flush:${input.threadId}:compact_boundary`,
          ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
          ...(preservedSegment ? { preservedSegment } : {}),
          budget
        }
      };
    }
  };
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
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
