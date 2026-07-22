import { describe, expect, test } from 'bun:test'
import { LSPApplyTool, LSPTool } from './lsp-tool.js'

describe('LSP tool boundaries', () => {
  test('keeps queries read-only and separates mutations', () => {
    expect(LSPTool.name).toBe('LSP')
    expect(LSPTool.isReadOnly?.()).toBe(true)
    expect(LSPTool.isConcurrencySafe?.()).toBe(true)
    expect(LSPApplyTool.name).toBe('LSPApply')
    expect(LSPApplyTool.isReadOnly?.()).toBe(false)
    expect(LSPApplyTool.isConcurrencySafe?.()).toBe(false)
  })
})
