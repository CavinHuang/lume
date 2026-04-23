export type LumeComposerTone = 'idle' | 'ready' | 'streaming'
export type LumeComposerMode = 'idle' | 'busy' | 'streaming'

interface DeriveLumeComposerStateInput {
  hasText: boolean
  mode?: LumeComposerMode
}

export interface LumeComposerState {
  canSend: boolean
  showBusy: boolean
  showStop: boolean
  tone: LumeComposerTone
}

export function deriveLumeComposerState({
  hasText,
  mode = 'idle',
}: DeriveLumeComposerStateInput): LumeComposerState {
  if (mode === 'streaming') {
    return {
      canSend: false,
      showBusy: false,
      showStop: true,
      tone: 'streaming',
    }
  }

  if (mode === 'busy') {
    return {
      canSend: false,
      showBusy: true,
      showStop: false,
      tone: 'streaming',
    }
  }

  if (hasText) {
    return {
      canSend: true,
      showBusy: false,
      showStop: false,
      tone: 'ready',
    }
  }

  return {
    canSend: false,
    showBusy: false,
    showStop: false,
    tone: 'idle',
  }
}
