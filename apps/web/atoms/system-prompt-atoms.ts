import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  BUILTIN_DEFAULT_ID,
  BUILTIN_DEFAULT_PROMPT,
  type SystemPrompt,
  type SystemPromptConfig
} from "@lume/shared";
import { userProfileAtom } from "./user-profile";

const STORAGE_KEY_SELECTED_PROMPT = "lume-selected-system-prompt-id";

/** Chat 视图中的提示词编辑侧栏开关 */
export const promptSidebarOpenAtom = atom<boolean>(false);

function appendDateTimeAndUserName(message: string, userName: string): string {
  const now = new Date();
  const dateTimeStr = now.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long"
  });
  return `${message}\n\n---\n当前时间: ${dateTimeStr}\n用户名: ${userName}`;
}

export function resolveSystemMessage(
  promptId: string | undefined,
  config: SystemPromptConfig,
  userName: string
): string | undefined {
  const resolvedId = promptId ?? config.defaultPromptId ?? BUILTIN_DEFAULT_ID;
  const prompt = config.prompts.find((item) => item.id === resolvedId);
  if (!prompt) return undefined;

  const base = prompt.content;
  if (!config.appendDateTimeAndUserName) {
    return base || undefined;
  }
  return appendDateTimeAndUserName(base, userName);
}

export const promptConfigAtom = atom<SystemPromptConfig>({
  version: 1,
  prompts: [BUILTIN_DEFAULT_PROMPT],
  defaultPromptId: BUILTIN_DEFAULT_ID,
  appendDateTimeAndUserName: true
});

export const selectedPromptIdAtom = atomWithStorage<string>(
  STORAGE_KEY_SELECTED_PROMPT,
  BUILTIN_DEFAULT_ID
);

export const promptListAtom = atom<SystemPrompt[]>((get) => get(promptConfigAtom).prompts);

export const defaultPromptIdAtom = atom<string | undefined>(
  (get) => get(promptConfigAtom).defaultPromptId
);

export const selectedPromptAtom = atom<SystemPrompt | undefined>((get) => {
  const config = get(promptConfigAtom);
  const selectedId = get(selectedPromptIdAtom);
  return config.prompts.find((item) => item.id === selectedId);
});

export const resolvedDefaultSystemMessageAtom = atom<string | undefined>((get) => {
  const config = get(promptConfigAtom);
  const userProfile = get(userProfileAtom);
  const promptId = config.defaultPromptId ?? BUILTIN_DEFAULT_ID;
  return resolveSystemMessage(promptId, config, userProfile.userName);
});

/** 每个对话独立的提示词选择（key: conversationId, value: promptId） */
export const conversationPromptIdAtom = atom<Map<string, string>>(new Map());
