import type { AgentEvent } from "@lume/shared";
import { supportsAnthropicThinking } from "../runner/model-capabilities";

export interface RuntimeCoreStreamWrapperState {
  lastFinalTextComplete: string | null;
  /** 当前 turn 索引（从 0 开始递增） */
  turnIndex: number;
  /** 当前活跃 turnId（在 turn_start 时生成，turn_end 时清除） */
  currentTurnId: string | null;
}

export interface RuntimeCoreStreamWrapperContext {
  provider?: string;
  baseUrl?: string;
}

export function createRuntimeCoreStreamWrapperState(): RuntimeCoreStreamWrapperState {
  return {
    lastFinalTextComplete: null,
    turnIndex: 0,
    currentTurnId: null
  };
}

export function applyRuntimeCoreStreamWrappers(
  events: AgentEvent[],
  state: RuntimeCoreStreamWrapperState,
  context: RuntimeCoreStreamWrapperContext = {}
): AgentEvent[] {
  const wrapped: AgentEvent[] = [];

  for (const event of events) {
    // Turn 边界事件：填充真实 turnId 和 turnIndex
    if (event.type === "turn_start") {
      const turnId = `turn-${state.turnIndex}`;
      state.currentTurnId = turnId;
      wrapped.push({ type: "turn_start", turnId, turnIndex: state.turnIndex });
      continue;
    }
    if (event.type === "turn_end") {
      const turnId = state.currentTurnId ?? `turn-${state.turnIndex}`;
      const turnIndex = state.turnIndex;
      state.turnIndex++;
      state.currentTurnId = null;
      wrapped.push({ type: "turn_end", turnId, turnIndex });
      continue;
    }

    // 为 turn 内的事件注入 turnId（仅当事件自身没有 turnId 且当前有活跃 turn 时）
    const enriched = injectTurnId(event, state.currentTurnId);

    if (enriched.type === "text_delta") {
      if (!enriched.text) {
        continue;
      }
      // 新的 delta 表示已经进入下一轮输出，不应继续拿上一轮的 final complete 去重。
      state.lastFinalTextComplete = null;
      wrapped.push(enriched);
      continue;
    }

    if (enriched.type === "text_complete") {
      const normalizedText = enriched.text.trim();
      if (!normalizedText) {
        continue;
      }
      if (
        !enriched.isIntermediate
        && shouldDropDuplicateFinalTextComplete(state.lastFinalTextComplete, enriched.text, context)
      ) {
        continue;
      }
      if (!enriched.isIntermediate) {
        state.lastFinalTextComplete = enriched.text;
      } else {
        state.lastFinalTextComplete = null;
      }
      wrapped.push(enriched);
      continue;
    }

    wrapped.push(enriched);
  }

  return wrapped;
}

function shouldDropDuplicateFinalTextComplete(
  previous: string | null,
  current: string,
  context: RuntimeCoreStreamWrapperContext
): boolean {
  if (!previous) {
    return false;
  }
  if (previous === current) {
    return true;
  }
  if (isAnthropicCompatStreamContext(context) && previous.trim() === current.trim()) {
    return true;
  }
  return false;
}

function isAnthropicCompatStreamContext(context: RuntimeCoreStreamWrapperContext): boolean {
  return context.provider === "anthropic" && !supportsAnthropicThinking(context.baseUrl);
}

/** 为支持 turnId 的事件注入当前 turnId（如果事件自身未设定且当前有活跃 turn） */
function injectTurnId(event: AgentEvent, currentTurnId: string | null): AgentEvent {
  if (!currentTurnId) return event;
  // 只有带 turnId 可选字段的事件类型才需要注入
  if (
    "turnId" in event
    && typeof (event as { turnId?: string }).turnId === "string"
    && (event as { turnId?: string }).turnId !== ""
  ) {
    return event; // 已有 turnId，不覆盖
  }
  if (
    event.type === "text_delta"
    || event.type === "text_complete"
    || event.type === "reasoning_delta"
    || event.type === "reasoning_complete"
    || event.type === "tool_start"
    || event.type === "tool_result"
    || event.type === "task_backgrounded"
    || event.type === "task_progress"
    || event.type === "task_started"
    || event.type === "task_notification"
    || event.type === "shell_backgrounded"
    || event.type === "shell_killed"
  ) {
    return { ...event, turnId: currentTurnId };
  }
  return event;
}
