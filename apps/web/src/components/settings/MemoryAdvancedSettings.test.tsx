import { describe, expect, mock, test } from 'bun:test'
import type { MemoryDiagnosticsSnapshot, MemoryRuntimeConfig } from '@lume/shared'
import { loadMemoryAdvancedSettings } from './MemoryAdvancedSettings'

describe('MemoryAdvancedSettings', () => {
  test('只并发加载运行配置与轻量诊断', async () => {
    const runtimeConfig = { proactiveWrite: true } as MemoryRuntimeConfig
    const diagnostics = { workspaceSlug: 'demo', jobs: [] } as unknown as MemoryDiagnosticsSnapshot
    const runtimeLoader = mock(async () => runtimeConfig)
    const diagnosticsLoader = mock(async (workspaceSlug: string) => {
      expect(workspaceSlug).toBe('demo')
      return diagnostics
    })

    await expect(loadMemoryAdvancedSettings('demo', {
      runtimeConfig: runtimeLoader,
      diagnostics: diagnosticsLoader,
    })).resolves.toEqual({ runtimeConfig, diagnostics })
    expect(runtimeLoader).toHaveBeenCalledTimes(1)
    expect(diagnosticsLoader).toHaveBeenCalledTimes(1)
  })
})
