import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()

function source(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8')
}

describe('skill market boundary', () => {
  test('market view does not expose self-owned skill version management', () => {
    const content = source('apps/web/src/components/skills/SkillsMarketView.tsx')

    expect(content).not.toContain('listSkillVersions')
    expect(content).not.toContain('restoreSkillVersion')
    expect(content).not.toContain('SkillVersionPanel')
    expect(content).not.toContain('版本历史')
  })
})
