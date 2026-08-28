/**
 * 主动建议 RPC handlers（sidecar）。
 *
 * 模式参考 model-meta-handlers / planning-todo-handlers：
 * - 每个 channel 用 `validateInput` 校验入参，失败 throw（→ reject → toast）
 * - list / stats / delete / clear-all / set-enabled 直通 store
 * - act / run-analysis 路由到 service
 *
 * 服务层自身 fail-open（不会向此处抛错），但 handlers 仍保持
 * 「入参非法即 throw」的 IPC 契约，调用方依赖此约定显示错误提示。
 */

import { SUGGESTION_IPC_CHANNELS, type SuggestionFeedback, type SuggestionRecord } from "@lume/shared";
import {
  clearSuggestions,
  deleteSuggestion,
  listSuggestions,
  setEnabled,
  suggestionStats,
} from "../services/suggest/store";
import {
  handleSuggestionFeedback,
  runAnalysisAndPersist,
  setSuggestionChangeBroadcaster,
} from "../services/suggest/service";
import type { NotificationWriter, RpcHandler } from "./types";
import { validateInput, z } from "./validation";

const SUGGESTION_STATUS_VALUES = ["suggested", "accepted", "ignored", "never"] as const;
const FEEDBACK_VALUES: readonly SuggestionFeedback[] = ["accepted", "ignored", "never"];

const listInputSchema = z
  .object({
    status: z.enum(SUGGESTION_STATUS_VALUES).optional(),
  })
  .strict();

const actInputSchema = z
  .object({
    id: z.number().int().positive(),
    feedback: z.enum(FEEDBACK_VALUES as [SuggestionFeedback, ...SuggestionFeedback[]]),
  })
  .strict();

const deleteInputSchema = z
  .object({
    id: z.number().int().positive(),
  })
  .strict();

const runAnalysisInputSchema = z
  .object({
    workspaceSlug: z.string().trim().min(1).optional(),
  })
  .strict();

const setEnabledInputSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export interface SuggestionHandlersContext {
  /**
   * sidecar → web 推送通道（与 agent-handlers / reading-handlers 同一机制）。
   * 用于实时广播建议变更：service.notifySuggestionsChanged 触发后，broadcaster
   * 经此通道推送 SUGGESTION_IPC_CHANNELS.CHANGED，web 收到后刷新建议状态。
  */
  writeNotification: NotificationWriter;
}

interface SuggestionHandlerDependencies {
  listSuggestions: typeof listSuggestions;
  deleteSuggestion: typeof deleteSuggestion;
  clearSuggestions: typeof clearSuggestions;
  suggestionStats: typeof suggestionStats;
  setEnabled: typeof setEnabled;
  handleSuggestionFeedback: typeof handleSuggestionFeedback;
  runAnalysisAndPersist: typeof runAnalysisAndPersist;
  setSuggestionChangeBroadcaster: typeof setSuggestionChangeBroadcaster;
}

const defaultDependencies: SuggestionHandlerDependencies = {
  listSuggestions,
  deleteSuggestion,
  clearSuggestions,
  suggestionStats,
  setEnabled,
  handleSuggestionFeedback,
  runAnalysisAndPersist,
  setSuggestionChangeBroadcaster,
};

export function createSuggestionHandlers(
  context: SuggestionHandlersContext,
  overrides: Partial<SuggestionHandlerDependencies> = {},
): Record<string, RpcHandler> {
  const dependencies = { ...defaultDependencies, ...overrides };
  // 接线 broadcaster：service 落库后调用 notifySuggestionsChanged → 此处推送 notification。
  // fail-open：notifySuggestionsChanged 内部已 try/catch，channel 推送失败不影响持久化。
  dependencies.setSuggestionChangeBroadcaster(() => {
    context.writeNotification(SUGGESTION_IPC_CHANNELS.CHANGED, { type: "suggestions_changed" });
  });
  return {
    [SUGGESTION_IPC_CHANNELS.LIST]: async (params) => {
      const input = validateInput(listInputSchema, params, SUGGESTION_IPC_CHANNELS.LIST);
      return dependencies.listSuggestions(input.status) satisfies SuggestionRecord[];
    },
    [SUGGESTION_IPC_CHANNELS.ACT]: async (params) => {
      const input = validateInput(actInputSchema, params, SUGGESTION_IPC_CHANNELS.ACT);
      await dependencies.handleSuggestionFeedback(input.id, input.feedback);
      return { ok: true as const };
    },
    [SUGGESTION_IPC_CHANNELS.STATS]: async () => {
      return dependencies.suggestionStats();
    },
    [SUGGESTION_IPC_CHANNELS.DELETE]: async (params) => {
      const input = validateInput(deleteInputSchema, params, SUGGESTION_IPC_CHANNELS.DELETE);
      dependencies.deleteSuggestion(input.id);
      return { ok: true as const };
    },
    [SUGGESTION_IPC_CHANNELS.CLEAR_ALL]: async () => {
      dependencies.clearSuggestions();
      return { ok: true as const };
    },
    [SUGGESTION_IPC_CHANNELS.RUN_ANALYSIS]: async (params) => {
      const input = validateInput(runAnalysisInputSchema, params, SUGGESTION_IPC_CHANNELS.RUN_ANALYSIS);
      const added = await dependencies.runAnalysisAndPersist({ workspaceSlug: input.workspaceSlug });
      return { added };
    },
    [SUGGESTION_IPC_CHANNELS.SET_ENABLED]: async (params) => {
      const input = validateInput(setEnabledInputSchema, params, SUGGESTION_IPC_CHANNELS.SET_ENABLED);
      dependencies.setEnabled(input.enabled);
      return { ok: true as const };
    },
  };
}
