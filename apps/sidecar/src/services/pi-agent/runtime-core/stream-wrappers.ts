import type { AgentEvent } from "@lume/shared";
import { supportsAnthropicThinking } from "../runner/model-capabilities";

export interface RuntimeCoreStreamWrapperState {
  lastFinalTextComplete: string | null;
}

export interface RuntimeCoreStreamWrapperContext {
  provider?: string;
  baseUrl?: string;
}

export function createRuntimeCoreStreamWrapperState(): RuntimeCoreStreamWrapperState {
  return {
    lastFinalTextComplete: null
  };
}

export function applyRuntimeCoreStreamWrappers(
  events: AgentEvent[],
  state: RuntimeCoreStreamWrapperState,
  context: RuntimeCoreStreamWrapperContext = {}
): AgentEvent[] {
  const wrapped: AgentEvent[] = [];

  for (const event of events) {
    if (event.type === "text_delta") {
      if (!event.text) {
        continue;
      }
      // 新的 delta 表示已经进入下一轮输出，不应继续拿上一轮的 final complete 去重。
      state.lastFinalTextComplete = null;
      wrapped.push(event);
      continue;
    }

    if (event.type === "text_complete") {
      const normalizedText = event.text.trim();
      if (!normalizedText) {
        continue;
      }
      if (
        !event.isIntermediate
        && shouldDropDuplicateFinalTextComplete(state.lastFinalTextComplete, event.text, context)
      ) {
        continue;
      }
      if (!event.isIntermediate) {
        state.lastFinalTextComplete = event.text;
      } else {
        state.lastFinalTextComplete = null;
      }
      wrapped.push(event);
      continue;
    }

    wrapped.push(event);
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
