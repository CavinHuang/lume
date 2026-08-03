import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import {
  SUGGESTION_IPC_CHANNELS,
  type SuggestionFeedback,
  type SuggestionRecord,
  type SuggestionStats,
} from '@lume/shared'

const call = <T>(method: string, params: unknown) =>
  invoke<T>('sidecar_call', { method, params })

/**
 * CHANGED 推送的 payload 仅作信号（service.notifySuggestionsChanged 触发，
 * 见 suggestion-handlers.ts）。web 收到后自取最新建议列表（bump 版本号 → 重拉）。
 */
export type SuggestionsChangedSignal = { type: 'suggestions_changed' }

/** 列出建议（可按 status 过滤） */
export const listSuggestions = (status?: SuggestionFeedback) =>
  call<SuggestionRecord[]>(
    SUGGESTION_IPC_CHANNELS.LIST,
    status ? { status } : {},
  )

/** 用户三态反馈 → service.handleSuggestionFeedback（学习权重 + 动作分发） */
export const actOnSuggestion = (id: number, feedback: SuggestionFeedback) =>
  call<{ ok: true }>(SUGGESTION_IPC_CHANNELS.ACT, { id, feedback })

/** 今日/累计统计 → store.suggestionStats */
export const getSuggestionStats = () =>
  call<SuggestionStats>(SUGGESTION_IPC_CHANNELS.STATS, {})

/** 删除单条 → store.deleteSuggestion */
export const deleteSuggestion = (id: number) =>
  call<{ ok: true }>(SUGGESTION_IPC_CHANNELS.DELETE, { id })

/** 清空全部 → store.clearSuggestions */
export const clearAllSuggestions = () =>
  call<{ ok: true }>(SUGGESTION_IPC_CHANNELS.CLEAR_ALL, {})

/** 触发 LLM 工作模式分析 → service.runAnalysisAndPersist；返回新增候选数 */
export const runSuggestionAnalysis = (workspaceSlug?: string) =>
  call<{ added: number }>(
    SUGGESTION_IPC_CHANNELS.RUN_ANALYSIS,
    workspaceSlug ? { workspaceSlug } : {},
  )

/** 开关建议系统 → store.setEnabled */
export const setSuggestionsEnabled = (enabled: boolean) =>
  call<{ ok: true }>(SUGGESTION_IPC_CHANNELS.SET_ENABLED, { enabled })

/**
 * 建议变更推送订阅（sidecar → web notification）。
 * 与 planning-todo.ts 的 onPlanningTodoChange 同一模式：包一层 listen，
 * 按 method 过滤 CHANGED。返回 unsubscribe（Promise<() => void>）。
 */
export const onSuggestionsChanged = (
  listener: (signal: SuggestionsChangedSignal) => void,
) =>
  listen<{ method: string; params: unknown }>('sidecar:event', (event) => {
    if (event.payload?.method === SUGGESTION_IPC_CHANNELS.CHANGED)
      listener(event.payload.params as SuggestionsChangedSignal)
  })
