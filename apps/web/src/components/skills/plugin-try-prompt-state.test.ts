import { describe, expect, test } from 'bun:test'
import { buildPluginTryPrompt } from './plugin-try-prompt-state'

describe('plugin try prompt state', () => {
  test('builds explicit plugin activation prompts', () => {
    expect(buildPluginTryPrompt('obsidian-bridge')).toBe('lume-plugin://obsidian-bridge 帮我检查 Obsidian 连接状态。')
    expect(buildPluginTryPrompt('lume-chrome')).toBe('lume-plugin://lume-chrome 说明当前 Chrome 连接状态，并告诉我你能控制什么。')
    expect(buildPluginTryPrompt('demo')).toBe('lume-plugin://demo 说明这个插件现在可以做什么。')
    expect(buildPluginTryPrompt("demo's")).toStartWith('lume-plugin://demo%27s ')
  })
})
