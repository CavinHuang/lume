import type { LumeRuntimeEvent } from "@lume/shared";

/**
 * 飞书流式卡片状态机（纯 reducer）。
 *
 * 消费 agent 运行时事件流，产出可渲染的有序块列表。与渲染完全分离：
 * 本文件不感知卡片 JSON 结构，渲染见 feishu-card-renderer。
 *
 * 文本/思考块按 assistant 消息 id 聚合：delta 增量追加，final 终态覆盖
 * （final 是权威全文，覆盖可消除 delta 与终态并存导致的重复文本）。
 */

export type ImRunCardStatus = "running" | "completed" | "failed" | "interrupted" | "turn_limited";

export type ImRunCardBlock =
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      status: "running" | "ok" | "failed";
      preview?: string;
      error?: string;
    };

export interface ImRunCardState {
  status: ImRunCardStatus;
  blocks: ImRunCardBlock[];
  startedAtMs: number;
  endedAtMs?: number;
  error?: string;
  usage?: {
    totalTokens: number;
    totalCostUSD: number;
  };
  /** 恢复压缩进行中（#709 第 4 项）：卡片头部显示「正在压缩上下文」中间态 */
  compacting?: boolean;
}

export function initialImRunCardState(startedAtMs: number): ImRunCardState {
  return { status: "running", blocks: [], startedAtMs };
}

/** assistant 消息在卡片中的块 id（文本/思考各一块，按消息聚合） */
function assistantBlockId(kind: "text" | "thinking", messageId?: string): string {
  return `${kind}:${messageId ?? "stream"}`;
}

function appendDelta(state: ImRunCardState, kind: "text" | "thinking", messageId: string | undefined, delta: string): ImRunCardState {
  if (!delta) return state;
  const id = assistantBlockId(kind, messageId);
  const index = state.blocks.findIndex((block) => block.id === id);
  if (index >= 0) {
    const block = state.blocks[index];
    if (block?.kind !== kind) return state;
    const blocks = state.blocks.slice();
    blocks[index] = { ...block, text: block.text + delta };
    return { ...state, blocks };
  }
  return {
    ...state,
    blocks: [...state.blocks, { kind, id, text: delta }]
  };
}

/**
 * assistant.final 兜底：仅当 delta 流完全缺席（非流式模型）时，用终态 blocks 补建
 * 文本/思考块；已有 delta 块则忽略（delta 流即完整文本，final 再叠加会重复）。
 */
function applyFinalBlocks(state: ImRunCardState, blocks: Array<{ type: "text" | "thinking"; text: string }>): ImRunCardState {
  let next = state;
  for (const kind of ["thinking", "text"] as const) {
    const hasExisting = next.blocks.some((block) => block.kind === kind);
    if (hasExisting) continue;
    const joined = blocks.filter((block) => block.type === kind).map((block) => block.text).join("");
    if (!joined) continue;
    next = {
      ...next,
      blocks: [...next.blocks, { kind, id: assistantBlockId(kind, undefined), text: joined }]
    };
  }
  return next;
}

function upsertToolBlock(
  state: ImRunCardState,
  toolCallId: string,
  patch: Partial<Pick<ImRunCardBlock & { kind: "tool" }, "toolName" | "status" | "preview" | "error">>
): ImRunCardState {
  const id = `tool:${toolCallId}`;
  const index = state.blocks.findIndex((block) => block.id === id);
  if (index >= 0) {
    const existing = state.blocks[index];
    if (!existing || existing.kind !== "tool") return state;
    const copy = state.blocks.slice();
    copy[index] = { ...existing, ...patch };
    return { ...state, blocks: copy };
  }
  return {
    ...state,
    blocks: [
      ...state.blocks,
      {
        kind: "tool",
        id,
        toolCallId,
        toolName: patch.toolName ?? toolCallId,
        status: patch.status ?? "running",
        ...(patch.preview !== undefined ? { preview: patch.preview } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {})
      }
    ]
  };
}

function terminal(state: ImRunCardState, status: Exclude<ImRunCardStatus, "running">, nowMs: number, error?: string): ImRunCardState {
  if (state.status !== "running") return state;
  return { ...state, status, endedAtMs: nowMs, ...(error ? { error } : {}) };
}

/** 消费一条运行时事件，返回新状态（无变化时返回原引用）。 */
export function reduceImRunCardEvent(state: ImRunCardState, event: LumeRuntimeEvent, nowMs: number = Date.now()): ImRunCardState {
  // 终态冻结正文/工具帧；usage.updated 允许迟到补齐终态 footer。
  if (state.status !== "running" && event.type !== "usage.updated") {
    return state;
  }
  switch (event.type) {
    case "assistant.delta":
      return appendDelta(state, "text", event.messageId, event.delta);
    case "assistant.thinking_delta":
      return appendDelta(state, "thinking", event.messageId, event.delta);
    case "assistant.final":
      return applyFinalBlocks(state, event.blocks);
    case "tool.started":
      return upsertToolBlock(state, event.toolCallId, {
        status: "running",
        ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {})
      });
    case "tool.completed":
      return upsertToolBlock(state, event.toolCallId, {
        status: "ok",
        ...(event.resultPreview ? { preview: event.resultPreview } : {})
      });
    case "tool.failed":
      return upsertToolBlock(state, event.toolCallId, {
        status: "failed",
        ...(event.error?.message ? { error: event.error.message } : {})
      });
    case "context.compaction.started":
      return state.compacting ? state : { ...state, compacting: true };
    case "context.compaction.completed":
      return state.compacting ? { ...state, compacting: false } : state;
    case "usage.updated": {
      const totalTokens = event.billing.cumulative.totalTokens;
      const totalCostUSD = event.billing.totalCostUSD;
      if (!Number.isFinite(totalTokens) || !Number.isFinite(totalCostUSD)) return state;
      if (state.usage?.totalTokens === totalTokens && state.usage.totalCostUSD === totalCostUSD) return state;
      return {
        ...state,
        usage: {
          totalTokens: Math.max(0, totalTokens),
          totalCostUSD: Math.max(0, totalCostUSD)
        }
      };
    }
    case "run.completed":
      return terminal(state, "completed", nowMs);
    case "run.failed":
      return terminal(state, "failed", nowMs, event.error?.message);
    case "run.cancelled":
      return terminal(state, "interrupted", nowMs);
    case "run.turn_limited":
      return terminal(state, "turn_limited", nowMs);
    default:
      return state;
  }
}
