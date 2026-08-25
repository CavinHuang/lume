import { describe, expect, test } from 'bun:test'
import {
  createEmptyTranscriptMergeState,
  mergeVoiceDictationTranscript,
} from './voice-transcript-merge'

describe('mergeVoiceDictationTranscript', () => {
  test('same session replaces current text with latest full result', () => {
    let state = createEmptyTranscriptMergeState()
    const first = mergeVoiceDictationTranscript(state, '你好', 's1')
    state = first.state
    const second = mergeVoiceDictationTranscript(state, '你好世界', 's1')
    expect(second.text).toBe('你好世界')
    expect(second.state.committedText).toBe('')
  })

  test('new session locks previous text into committed prefix', () => {
    let state = createEmptyTranscriptMergeState()
    state = mergeVoiceDictationTranscript(state, '第一段', 's1').state
    const next = mergeVoiceDictationTranscript(state, '第二段', 's2')
    expect(next.text).toBe('第一段第二段')
    expect(next.state.committedText).toBe('第一段')
  })

  test('english word boundaries get a joining space across sessions', () => {
    let state = createEmptyTranscriptMergeState()
    state = mergeVoiceDictationTranscript(state, 'hello world', 's1').state
    const next = mergeVoiceDictationTranscript(state, 'again', 's2')
    expect(next.text).toBe('hello world again')
  })

  test('empty incoming keeps merged text unchanged and state untouched', () => {
    let state = createEmptyTranscriptMergeState()
    state = mergeVoiceDictationTranscript(state, '已确认', 's1').state
    const empty = mergeVoiceDictationTranscript(state, '   ', 's1')
    expect(empty.text).toBe('已确认')
    expect(empty.state).toBe(state)
  })

  test('reconnect after reconnect accumulates multiple sessions in order', () => {
    let state = createEmptyTranscriptMergeState()
    for (const [text, id] of [['一', 'a'], ['二', 'b'], ['三', 'c']] as const) {
      state = mergeVoiceDictationTranscript(state, text, id).state
    }
    expect(mergeVoiceDictationTranscript(state, '', 'c').text).toBe('一二三')
  })
})
