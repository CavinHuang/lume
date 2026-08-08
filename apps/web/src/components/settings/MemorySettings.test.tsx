import { expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('./MemoryAdvancedSettings', () => ({
  MemoryAdvancedSettings: () => React.createElement('div', { 'data-test-memory-advanced': true }, '记忆设置'),
}))

const { MemorySettings } = await import('./MemorySettings')

test('MemorySettings 只保留高级配置入口', () => {
  const html = renderToStaticMarkup(<MemorySettings />)
  expect(html).toContain('data-test-memory-advanced="true"')
  expect(html).toContain('记忆设置')
  expect(html).not.toContain('用户记忆')
})
