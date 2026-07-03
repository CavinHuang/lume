/**
 * 侧边栏状态 atoms
 *
 * 注：sidebarCollapsedAtom 已在 tab-atoms.ts 中定义并导出，
 * 此文件提供侧边栏宽度等扩展状态，并重新导出折叠状态以保持独立模块语义。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** 侧边栏宽度（展开时） */
export const sidebarWidthAtom = atomWithStorage('sidebar-width', 260)

/**
 * 委派子会话展开状态（内存态，对齐 Proma 双 set 机制，不持久化）。
 * - expandedThreadIdsAtom：用户手动展开的母会话 id
 * - collapsedThreadIdsAtom：用户手动收起的母会话 id，用于压制"激活子会话自动展开"
 */
export const expandedThreadIdsAtom = atom<Set<string>>(new Set())
export const collapsedThreadIdsAtom = atom<Set<string>>(new Set())
