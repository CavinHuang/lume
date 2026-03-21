import { atom } from "jotai";
import type { ChatToolInfo } from "@lume/shared";

/** 从 sidecar 加载的工具列表（唯一状态源） */
export const chatToolsAtom = atom<ChatToolInfo[]>([]);

/** 当前启用且可用的工具 ID */
export const activeToolIdsAtom = atom<string[]>((get) =>
  get(chatToolsAtom)
    .filter((item) => item.enabled && item.available)
    .map((item) => item.meta.id)
);

/** 是否至少有一个工具处于启用状态 */
export const hasActiveToolsAtom = atom<boolean>((get) => get(activeToolIdsAtom).length > 0);
