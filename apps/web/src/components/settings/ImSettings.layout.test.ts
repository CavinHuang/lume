import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(new URL('./ImSettings.tsx', import.meta.url), 'utf8')
const selectSource = readFileSync(new URL('../ui/select.tsx', import.meta.url), 'utf8')

describe('ImSettings layout', () => {
  test('keeps account creation inside a dialog instead of a permanent right panel', () => {
    expect(source).toContain('<Dialog open={addDialogOpen}')
    expect(source).not.toContain('lg:grid-cols-[minmax(0,1fr)_300px]')
  })

  test('keeps workspace select dropdown above the account dialog overlay', () => {
    expect(selectSource).toContain('z-[130]')
  })
})
