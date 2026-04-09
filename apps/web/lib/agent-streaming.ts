import type { SDKMessage } from "@lume/shared";

export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  intent?: string;
  displayName?: string;
  parentToolUseId?: string;
  taskId?: string;
  shellId?: string;
  isBackground?: boolean;
  startedAt?: number;
  elapsedSeconds?: number;
  elapsedMs?: number;
  progressDescription?: string;
  result?: string;
  isError?: boolean;
  done: boolean;
}

export interface AgentStreamState {
  running: boolean;
  sdkMessages?: SDKMessage[];
  content: string;
  reasoning?: string;
  toolActivities: ToolActivity[];
  model?: string;
  inputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  isCompacting?: boolean;
  streamStartedAt?: number;
  firstOutputAt?: number;
  /** 当前活跃的 turnId */
  currentTurnId?: string;
  /** 已完成的 turn 数量 */
  turnCount?: number;
}

function extractTextFromAssistantMessage(message: Extract<SDKMessage, { type: "assistant" }>): string {
  return (message.message?.content ?? [])
    .filter((block) => !!block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

function extractThinkingFromAssistantMessage(message: Extract<SDKMessage, { type: "assistant" }>): string {
  return (message.message?.content ?? [])
    .filter((block) => !!block && typeof block === "object" && (block as { type?: string }).type === "thinking")
    .map((block) => {
      const value = block as { thinking?: string; text?: string };
      return value.thinking ?? value.text ?? "";
    })
    .join("");
}

function upsertToolActivity(prev: ToolActivity[], next: ToolActivity): ToolActivity[] {
  const idx = prev.findIndex((item) => item.toolUseId === next.toolUseId);
  if (idx === -1) return [...prev, next];
  const copy = [...prev];
  copy[idx] = { ...copy[idx]!, ...next };
  return copy;
}

export function applySdkMessage(prev: AgentStreamState, message: SDKMessage): AgentStreamState {
  const now = Date.now();
  const streamStartedAt = prev.streamStartedAt ?? now;
  let next: AgentStreamState = {
    ...prev,
    streamStartedAt,
    sdkMessages: [...(prev.sdkMessages ?? []), message],
  };

  if (message.type === "stream_event") {
    const event = message.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
        next = {
          ...next,
          content: next.content + event.delta.text,
          firstOutputAt: next.firstOutputAt ?? now,
        };
      } else if (event.delta?.type === "thinking_delta") {
        const text = typeof event.delta.thinking === "string" ? event.delta.thinking : event.delta.text ?? "";
        if (text) {
          next = {
            ...next,
            reasoning: (next.reasoning ?? "") + text,
            firstOutputAt: next.firstOutputAt ?? now,
          };
        }
      }
    }
    return next;
  }

  if (message.type === "assistant") {
    const text = extractTextFromAssistantMessage(message);
    const reasoning = extractThinkingFromAssistantMessage(message);
    if (text) {
      next.content = mergeStreamingText(next.content, text);
      next.firstOutputAt = next.firstOutputAt ?? now;
    }
    if (reasoning) {
      next.reasoning = mergeStreamingText(next.reasoning ?? "", reasoning);
      next.firstOutputAt = next.firstOutputAt ?? now;
    }
    for (const block of message.message?.content ?? []) {
      if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
      const tool = block as { id: string; name: string; input: Record<string, unknown> };
      next.toolActivities = upsertToolActivity(next.toolActivities, {
        toolUseId: tool.id,
        toolName: tool.name,
        input: tool.input ?? {},
        parentToolUseId: message.parent_tool_use_id ?? undefined,
        startedAt: now,
        done: false,
      });
    }
    return next;
  }

  if (message.type === "user") {
    for (const block of message.message?.content ?? []) {
      if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
      const result = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
      const resultText = typeof result.content === "string"
        ? result.content
        : Array.isArray(result.content)
          ? result.content
              .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object")
              .filter((item) => item.type === "text" && typeof item.text === "string")
              .map((item) => item.text ?? "")
              .join("\n")
          : "";
      next.toolActivities = next.toolActivities.map((activity) =>
        activity.toolUseId === result.tool_use_id
          ? {
              ...activity,
              done: true,
              isError: result.is_error === true,
              result: resultText,
              elapsedMs: activity.startedAt ? Math.max(0, now - activity.startedAt) : activity.elapsedMs,
            }
          : activity
      );
    }
    return next;
  }

  if (message.type === "tool_result") {
    const output = message.result.output as unknown;
    const resultText = typeof output === "string"
      ? output
      : Array.isArray(output)
        ? output
            .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object")
            .filter((item) => item.type === "text" && typeof item.text === "string")
            .map((item) => item.text ?? "")
            .join("\n")
        : (() => {
            try {
              return JSON.stringify(output, null, 2);
            } catch {
              return String(output ?? "");
            }
          })();

    next.toolActivities = next.toolActivities.map((activity) =>
      activity.toolUseId === message.result.tool_use_id
        ? {
            ...activity,
            toolName: message.result.tool_name || activity.toolName,
            done: true,
            isError: false,
            result: resultText,
            elapsedMs: activity.startedAt ? Math.max(0, now - activity.startedAt) : activity.elapsedMs,
          }
        : activity
    );
    return next;
  }

  if (message.type === "system") {
    if (message.subtype === "task_started") {
      next.toolActivities = upsertToolActivity(next.toolActivities, {
        toolUseId: message.tool_use_id ?? message.task_id,
        toolName: "Task",
        input: {},
        taskId: message.task_id,
        startedAt: now,
        done: false,
        intent: message.description,
      });
    } else if (message.subtype === "task_progress") {
      next.toolActivities = next.toolActivities.map((activity) =>
        activity.toolUseId === (message.tool_use_id ?? message.task_id)
          ? {
              ...activity,
              taskId: message.task_id,
              elapsedMs: message.usage?.duration_ms ?? activity.elapsedMs,
              elapsedSeconds: message.usage?.duration_ms ? Math.floor(message.usage.duration_ms / 1000) : activity.elapsedSeconds,
              progressDescription: message.description ?? activity.progressDescription,
            }
          : activity
      );
    } else if (message.subtype === "task_notification") {
      next.toolActivities = next.toolActivities.map((activity) =>
        activity.toolUseId === (message.tool_use_id ?? message.task_id)
          ? {
              ...activity,
              taskId: message.task_id,
              done: true,
              isError: message.status !== "completed",
              result: message.summary ?? message.message ?? activity.result,
              elapsedMs: message.usage?.duration_ms ?? activity.elapsedMs,
            }
          : activity
      );
    } else if (message.subtype === "compact_boundary") {
      next.isCompacting = false;
    }
    return next;
  }

  if (message.type === "result") {
    const usage = message.usage;
    next.running = false;
    next.isCompacting = false;
    next.inputTokens = usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : next.inputTokens;
    next.totalTokens = usage
      ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      : next.totalTokens;
    next.contextWindow = message.modelUsage ? Object.values(message.modelUsage)[0]?.contextWindow : next.contextWindow;
    next.toolActivities = next.toolActivities.map((activity) => (activity.done ? activity : { ...activity, done: true }));
  }

  return next;
}

export function mergeStreamingText(current: string, next: string): string {
  if (!next) return current;
  if (!current) return next;
  if (current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;

  const maxOverlap = Math.min(current.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(next.slice(0, overlap))) {
      return current + next.slice(overlap);
    }
  }
  return current + next;
}
