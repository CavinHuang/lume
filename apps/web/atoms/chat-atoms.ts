import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { ChatMessage, ConversationMeta, FileAttachment } from "@lume/shared";

interface SelectedModel {
  channelId: string;
  modelId: string;
}

export type ContextLengthValue = 0 | 5 | 10 | 15 | 20 | "infinite";

export const CONTEXT_LENGTH_OPTIONS: ContextLengthValue[] = [0, 5, 10, 15, 20, "infinite"];

export const conversationsAtom = atom<ConversationMeta[]>([]);
export const currentConversationIdAtom = atom<string | null>(null);
export const currentMessagesAtom = atom<ChatMessage[]>([]);

export interface ConversationStreamState {
  streaming: boolean;
  content: string;
  reasoning: string;
}

export const streamingStatesAtom = atom<Map<string, ConversationStreamState>>(new Map());

export const streamingConversationIdsAtom = atom<Set<string>>((get) => {
  const states = get(streamingStatesAtom);
  const ids = new Set<string>();
  for (const [id, state] of states) {
    if (state.streaming) ids.add(id);
  }
  return ids;
});

export const selectedModelAtom = atomWithStorage<SelectedModel | null>(
  "lume-selected-model",
  null
);

export const currentConversationAtom = atom<ConversationMeta | null>((get) => {
  const conversations = get(conversationsAtom);
  const currentId = get(currentConversationIdAtom);
  if (!currentId) return null;
  return conversations.find((item) => item.id === currentId) ?? null;
});

export const contextLengthAtom = atomWithStorage<ContextLengthValue>("lume-context-length", 20);
export const contextDividersAtom = atom<string[]>([]);
export const thinkingEnabledAtom = atomWithStorage<boolean>("lume-thinking-enabled", false);

export interface PendingAttachment extends FileAttachment {
  previewUrl?: string;
}

export const pendingAttachmentsAtom = atom<PendingAttachment[]>([]);
export const hasMoreMessagesAtom = atom<boolean>(false);
export const chatStreamErrorsAtom = atom<Map<string, string>>(new Map());

export const currentChatErrorAtom = atom<string | null>((get) => {
  const currentId = get(currentConversationIdAtom);
  if (!currentId) return null;
  return get(chatStreamErrorsAtom).get(currentId) ?? null;
});
