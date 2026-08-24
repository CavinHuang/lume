/**
 * 听写转写文本合并：同一 ASR 会话内服务端返回全量累积结果（直接替换），
 * 跨会话（服务端静音超时后重开）把先前文本锁定进 committedText 拼接保留。
 */

const ASCII_WORD_EDGE_PATTERN = /[A-Za-z0-9]/

export interface VoiceDictationTranscriptMergeState {
  /** 来自已结束会话的锁定文本 */
  committedText: string
  /** 当前活跃会话的最新文本 */
  currentSessionText: string
  /** 当前活跃会话 ID */
  currentSessionId: string
}

export interface VoiceDictationTranscriptMergeResult {
  state: VoiceDictationTranscriptMergeState
  text: string
}

function joinTranscriptParts(left: string, right: string): string {
  if (!left) return right
  if (!right) return left

  const lastLeft = left.at(-1) ?? ''
  const firstRight = right.at(0) ?? ''
  // 英文单词边界补空格；中文等直接拼接。
  const separator = ASCII_WORD_EDGE_PATTERN.test(lastLeft) && ASCII_WORD_EDGE_PATTERN.test(firstRight)
    ? ' '
    : ''
  return `${left}${separator}${right}`
}

export function mergeVoiceDictationTranscript(
  state: VoiceDictationTranscriptMergeState,
  incomingText: string,
  sessionId: string,
): VoiceDictationTranscriptMergeResult {
  const text = incomingText.trim()
  if (!text) {
    return {
      state,
      text: joinTranscriptParts(state.committedText, state.currentSessionText),
    }
  }

  if (sessionId === state.currentSessionId) {
    const newState: VoiceDictationTranscriptMergeState = {
      committedText: state.committedText,
      currentSessionText: text,
      currentSessionId: sessionId,
    }
    return {
      state: newState,
      text: joinTranscriptParts(state.committedText, text),
    }
  }

  // 新会话（首次或重连后）：锁定之前的文本。
  const prevFull = joinTranscriptParts(state.committedText, state.currentSessionText)
  const newState: VoiceDictationTranscriptMergeState = {
    committedText: prevFull,
    currentSessionText: text,
    currentSessionId: sessionId,
  }
  return {
    state: newState,
    text: joinTranscriptParts(prevFull, text),
  }
}

export function createEmptyTranscriptMergeState(): VoiceDictationTranscriptMergeState {
  return { committedText: '', currentSessionText: '', currentSessionId: '' }
}
