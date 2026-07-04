import type { JSONContent } from '@tiptap/core'

/** 草稿/历史条目的富文本结构，即 editor.getJSON() 的返回类型。 */
export type AgentInputDraftJSON = JSONContent

/** 每个会话保留的输入历史条数上限。 */
export const AGENT_INPUT_HISTORY_LIMIT = 100

export function upsertDraft(
  state: Record<string, AgentInputDraftJSON>,
  threadId: string,
  json: AgentInputDraftJSON,
): Record<string, AgentInputDraftJSON> {
  return { ...state, [threadId]: json }
}

export function removeDraft(
  state: Record<string, AgentInputDraftJSON>,
  threadId: string,
): Record<string, AgentInputDraftJSON> {
  if (!(threadId in state)) return state
  const { [threadId]: _removed, ...rest } = state
  return rest
}

/** 在队首插入（index 0 = 最近一条），超过 limit 裁掉尾部。 */
export function prependHistory(
  state: Record<string, AgentInputDraftJSON[]>,
  threadId: string,
  json: AgentInputDraftJSON,
  limit: number = AGENT_INPUT_HISTORY_LIMIT,
): Record<string, AgentInputDraftJSON[]> {
  const current = state[threadId] ?? []
  const next = [json, ...current].slice(0, limit)
  return { ...state, [threadId]: next }
}

export function removeHistory(
  state: Record<string, AgentInputDraftJSON[]>,
  threadId: string,
): Record<string, AgentInputDraftJSON[]> {
  if (!(threadId in state)) return state
  const { [threadId]: _removed, ...rest } = state
  return rest
}

/** 递归提取节点纯文本，用于判定空草稿。 */
function extractText(node: JSONContent): string {
  let text = node.text ?? ''
  if (node.content) {
    for (const child of node.content) text += extractText(child)
  }
  return text
}

/** 是否为空草稿（无可见文本）。空草稿不入盘，避免存无意义空对象。 */
export function isEmptyDraft(json: AgentInputDraftJSON | undefined): boolean {
  if (!json) return true
  return extractText(json).trim().length === 0
}
