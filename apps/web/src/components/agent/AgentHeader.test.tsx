import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'

mock.module('./WorkspacePicker', () => ({
  WorkspacePicker: () => <div>workspace-picker</div>,
}))

const { AgentHeader } = await import('./AgentHeader')

describe('AgentHeader readOnly', () => {
  test('hides the workspace picker when readOnly', () => {
    const store = createStore()
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentHeader threadId="thread-1" readOnly />
      </Provider>,
    )
    expect(html).not.toContain('workspace-picker')
  })

  test('shows the workspace picker by default', () => {
    const store = createStore()
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentHeader threadId="thread-1" />
      </Provider>,
    )
    expect(html).toContain('workspace-picker')
  })
})
