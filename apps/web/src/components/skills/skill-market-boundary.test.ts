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

  test('market view does not mount the skill settings surface', () => {
    const content = source('apps/web/src/components/skills/SkillsMarketView.tsx')

    expect(content).not.toContain('SkillSettingsView')
    expect(content).not.toContain('SkillAddSourceDialog')
    expect(content).not.toContain('技能设置')
  })

  test('market source dialog documents marketplace root and direct installs', () => {
    const content = source('apps/web/src/components/skills/SkillsMarketView.tsx')

    expect(content).toContain('单独安装插件')
    expect(content).toContain('单独安装技能')
    expect(content).toContain('.lume-plugin/marketplace.json')
    expect(content).toContain('plugins[]')
    expect(content).toContain('skills[]')
    expect(content).toContain('.lume-plugin/plugin.json')
    expect(content).toContain('.codex-plugin/plugin.json')
    expect(content).toContain('SKILL.md')
  })

  test('plugin details use an independent page rather than a modal dialog', () => {
    const content = source('apps/web/src/components/skills/SkillsMarketView.tsx')

    expect(content).toContain('PluginDetailPage')
    expect(content).not.toContain('PluginDetailDialog')
    expect(content).not.toContain('pluginDetailOpen')
  })
})
