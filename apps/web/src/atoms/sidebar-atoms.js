/**
 * 侧边栏状态 atoms
 *
 * 注：sidebarCollapsedAtom 已在 tab-atoms.ts 中定义并导出，
 * 此文件提供侧边栏宽度等扩展状态，并重新导出折叠状态以保持独立模块语义。
 */
import { atomWithStorage } from 'jotai/utils';
/** 侧边栏宽度（展开时） */
export const sidebarWidthAtom = atomWithStorage('sidebar-width', 260);
