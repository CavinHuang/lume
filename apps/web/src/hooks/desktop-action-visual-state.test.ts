import { describe, expect, test } from 'bun:test'
import { projectDesktopActionVisualEvent } from './desktop-action-visual-state'

describe('projectDesktopActionVisualEvent', () => {
  test('keeps only safe visual metadata from a desktop action event', () => {
    const state = projectDesktopActionVisualEvent({
      id: 'visual-1',
      type: 'desktop.action_visual',
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-07-07T10:00:00.000Z',
      phase: 'started',
      toolCallId: 'tool-1',
      action: 'type_text',
      app: { id: 'wechat.exe', name: '微信' },
      targetLabel: '输入框',
      point: { x: 420, y: 360 },
      text: 'password=secret',
    } as never)

    expect(state).toEqual({
      id: 'visual-1',
      threadId: 'thread-1',
      phase: 'started',
      action: 'type_text',
      appName: '微信',
      targetLabel: '输入框',
      point: { x: 420, y: 360 },
      updatedAt: Date.parse('2026-07-07T10:00:00.000Z'),
    })
    expect(JSON.stringify(state)).not.toContain('password=secret')
  })
})
