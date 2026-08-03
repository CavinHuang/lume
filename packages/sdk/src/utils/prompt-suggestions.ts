export function generatePromptSuggestion(
  assistantText: string,
  toolsUsed: string[] = [],
): string | null {
  const normalized = assistantText.trim()
  if (!normalized) return null

  if (/need|clarify|which|confirm|choose/i.test(normalized)) {
    return 'Clarify the missing requirement or confirm the next step.'
  }

  if (toolsUsed.some((tool) => ['Write', 'Edit', 'NotebookEdit'].includes(tool))) {
    return 'Review the changes or ask for tests on the updated files.'
  }

  if (toolsUsed.some((tool) => ['Bash', 'ProcessOutput', 'TaskOutput', 'Agent'].includes(tool))) {
    return 'Ask for verification details, logs, or a follow-up change.'
  }

  const firstSentence = normalized.split(/[.!?]\s/)[0]?.trim()
  if (!firstSentence) return null

  return `Ask a focused follow-up about: ${firstSentence.slice(0, 120)}`
}
