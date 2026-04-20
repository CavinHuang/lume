import { describe, expect, test } from 'bun:test'
import { PERMISSION_OPTIONS } from './agent-settings-state'

describe('PERMISSION_OPTIONS', () => {
  test('covers every permission mode with icon and visual tone metadata', () => {
    expect(PERMISSION_OPTIONS).toEqual([
      expect.objectContaining({
        value: 'default',
        icon: 'shield',
        tone: 'sky',
        emphasis: '受控',
      }),
      expect.objectContaining({
        value: 'acceptEdits',
        icon: 'pencil',
        tone: 'emerald',
        emphasis: '高效',
      }),
      expect.objectContaining({
        value: 'bypassPermissions',
        icon: 'shield-off',
        tone: 'amber',
        emphasis: '高风险',
      }),
      expect.objectContaining({
        value: 'plan',
        icon: 'map',
        tone: 'violet',
        emphasis: '规划',
      }),
    ])
  })
})
