export function resolveConversationPromptId(input: {
  existingPromptId?: string | null;
  availablePromptIds: string[];
  defaultPromptId?: string | null;
  selectedPromptId?: string | null;
}): string | null {
  if (input.existingPromptId && input.availablePromptIds.includes(input.existingPromptId)) {
    return input.existingPromptId;
  }

  if (input.defaultPromptId && input.availablePromptIds.includes(input.defaultPromptId)) {
    return input.defaultPromptId;
  }

  if (input.selectedPromptId && input.availablePromptIds.includes(input.selectedPromptId)) {
    return input.selectedPromptId;
  }

  return null;
}
