import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/lib/desktop-api', () => ({
  sidecarCall: async () => undefined,
}))

const { BrowserAuthBanner, buildBrowserAuthSubmission } = await import('./BrowserAuthBanner')

describe('BrowserAuthBanner', () => {
  test('builds a browserAuth submission without extra metadata', () => {
    expect(buildBrowserAuthSubmission({
      threadId: 'thread-1',
      requestId: 'auth-1',
      values: { password: 'password-value' },
    })).toEqual({
      threadId: 'thread-1',
      requestId: 'auth-1',
      status: 'submitted',
      values: { password: 'password-value' },
    })
  })

  test('renders safe metadata and never renders submitted secrets', () => {
    const html = renderToStaticMarkup(
      <BrowserAuthBanner
        threadId="thread-1"
        request={{
          threadId: 'thread-1',
          requestId: 'auth-1',
          origin: 'https://accounts.example.test',
          reason: 'Sign in to continue.',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          fields: [{
            id: 'password',
            label: 'Password',
            type: 'password',
            autocomplete: 'current-password',
            required: true,
          }],
        }}
      />,
    )

    expect(html).toContain('https://accounts.example.test')
    expect(html).toContain('Agent')
    expect(html).not.toContain('password-value')
  })
})
