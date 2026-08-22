import { atom } from 'jotai'
import { createThreadSliceFamily } from './agent-atoms'

/**
 * 划线引用（Quoted Selection）状态层
 *
 * 选中文本引用的「一次性快照」：在 Agent 历史消息/预览面板划选文本后写入，
 * 输入框展示 chip，发送时序列化进消息体并立即消费（删除）。
 *
 * 与 Lume 既有的代码行级引用（AgentDiffCommentAttachment，走 commentAttachments
 * 独立通道）互补 —— quoted_selection 专攻自由文本，不覆盖代码行选。
 */

/** 选中文本引用的来源类型 */
export type QuotedSelectionSourceType = 'agent-history' | 'file' | 'reading'

/** 从历史消息 / 预览面板中选中的文本引用 */
export interface QuotedSelection {
  /** 选中的文本内容 */
  text: string
  /** 来源文件路径；历史引用时作为兼容展示字段 */
  filePath: string
  /** 引用来源类型 */
  sourceType: QuotedSelectionSourceType
  /** 面向用户展示的来源名称 */
  sourceLabel?: string
  /** Agent 历史消息 ID */
  messageId?: string
  /** Agent 历史消息角色 */
  messageRole?: 'user' | 'assistant' | 'system'
  /** 起始行号（1-based，代码可计算，markdown 等无则为 undefined） */
  startLine?: number
  /** 结束行号（1-based） */
  endLine?: number
  /** 捕获时间戳（乐观锁 key，发送消费时比对防误删） */
  capturedAt: number
}

/**
 * 每会话的引用选中文本 Record（每次新选中覆盖旧值）。
 *
 * 不持久化（不用 atomWithStorage）：引用是一次性快照，发送即消费，刷新后不应残留。
 * 写入必须 root atom 不可变展开：set(map, prev => ({ ...prev, [threadId]: next }))，
 * 否则 createThreadSliceFamily 的 selectAtom 无法跳过未变 thread 的重渲染。
 */
export const quotedSelectionMapAtom = atom<Record<string, QuotedSelection>>({})

/** 当前会话的引用选中文本（派生，返回 QuotedSelection | undefined） */
export const quotedSelectionFamily = createThreadSliceFamily(quotedSelectionMapAtom)
