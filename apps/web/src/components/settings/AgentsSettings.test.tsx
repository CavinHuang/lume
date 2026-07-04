import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentsSettings } from './AgentsSettings'

describe('AgentsSettings', () => {
  test('renders role directory items as full agent cards', () => {
    const markup = renderToStaticMarkup(<AgentsSettings />)
    const roleButtonClass = markup.match(/<button[^>]*class="([^"]*)"[^>]*>[\s\S]*?陆寻/)?.[1]

    expect(roleButtonClass).toBeDefined()
    for (const className of [
      'h-auto',
      'w-full',
      'flex-col',
      'items-stretch',
      'justify-start',
      'gap-0',
      'p-0',
      'whitespace-normal',
    ]) {
      expect(roleButtonClass).toContain(className)
    }
  })
})
