import { stripAfterglowLines } from '@lume/shared'
import { stripFileReferenceProtocolFromMarkdown } from '../thread-file-links'

export interface CopyFeedbackState {
  resetTimeoutId: ReturnType<typeof setTimeout> | null
}

interface CopyFeedbackDeps {
  setCopied: (next: boolean) => void
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  delayMs?: number
}

export function showTemporaryCopiedFeedback(
  state: CopyFeedbackState,
  { setCopied, setTimer, clearTimer, delayMs = 3000 }: CopyFeedbackDeps,
): void {
  setCopied(true)
  if (state.resetTimeoutId !== null) {
    clearTimer(state.resetTimeoutId)
  }
  state.resetTimeoutId = setTimer(() => {
    state.resetTimeoutId = null
    setCopied(false)
  }, delayMs)
}

export function getCopyTextWithoutAfterglow(container: Node & ParentNode): string {
  const clone = container.cloneNode(true) as Node & ParentNode
  clone.querySelectorAll('[data-afterglow]').forEach((node) => node.remove())
  clone.querySelectorAll<HTMLElement>('[data-file-reference-copy-text]').forEach((node) => {
    node.textContent = node.dataset.fileReferenceCopyText ?? node.textContent
  })
  return (clone.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export function getAssistantCopyText(text: string): string {
  return stripFileReferenceProtocolFromMarkdown(stripAfterglowLines(text))
}
