export type LumeComposerTone = 'idle' | 'ready' | 'streaming'

interface DeriveLumeComposerStateInput {
  text: string
  disabled?: boolean
}

interface LumeComposerState {
  canSend: boolean
  showStop: boolean
  tone: LumeComposerTone
}

export function deriveLumeComposerState({
  text,
  disabled = false,
}: DeriveLumeComposerStateInput): LumeComposerState {
  if (disabled) {
    return {
      canSend: false,
      showStop: true,
      tone: 'streaming',
    }
  }

  if (text.trim().length > 0) {
    return {
      canSend: true,
      showStop: false,
      tone: 'ready',
    }
  }

  return {
    canSend: false,
    showStop: false,
    tone: 'idle',
  }
}
