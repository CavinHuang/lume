import type { FileAttachment } from "@lume/shared";

export function shouldPrepareConversationAutoTitle(input: {
  content: string;
  messageCountBeforeSend: number;
  currentTitle?: string | null;
  hasPendingTitle: boolean;
}): boolean {
  if (input.hasPendingTitle) return false;
  if (input.content.trim().length === 0) return false;
  const isDefaultTitledConversation = !input.currentTitle || input.currentTitle === "新对话";
  return input.messageCountBeforeSend === 0 || isDefaultTitledConversation;
}

export function filterValidContextDividers(
  contextDividers: string[],
  messages: Array<{ id: string }>
): string[] {
  const messageIdSet = new Set(messages.map((msg) => msg.id));
  return contextDividers.filter((id) => messageIdSet.has(id));
}

export function mergeInlineEditAttachments(input: {
  kept: FileAttachment[];
  added: FileAttachment[];
}): FileAttachment[] {
  return [...input.kept, ...input.added];
}
