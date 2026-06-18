import { describe, expect, test } from 'bun:test'
import type { SkillCatalogItem } from '@lume/shared'
import { buildSkillActionLabel, buildSkillInstallRequest } from './skill-market-state'

function marketItem(input: Partial<SkillCatalogItem> & Pick<SkillCatalogItem, 'installState'>): SkillCatalogItem {
  return {
    id: 'built-in:alpha',
    slug: 'alpha',
    name: 'Alpha',
    sourceType: 'built-in',
    trustLevel: 'trusted',
    ...input,
  }
}

describe('skill-market-state', () => {
  test('labels update-available skills as updates', () => {
    expect(buildSkillActionLabel(marketItem({ installState: 'update-available' }))).toBe('更新')
    expect(buildSkillActionLabel(marketItem({ installState: 'installed' }))).toBe('移除')
    expect(buildSkillActionLabel(marketItem({ installState: 'not-installed' }))).toBe('安装')
  })

  test('builds overwrite requests only for update actions', () => {
    expect(buildSkillInstallRequest('demo', marketItem({ installState: 'not-installed' }))).toEqual({
      workspaceSlug: 'demo',
      skillId: 'built-in:alpha',
      overwrite: false,
    })
    expect(buildSkillInstallRequest('demo', marketItem({ installState: 'update-available' }))).toEqual({
      workspaceSlug: 'demo',
      skillId: 'built-in:alpha',
      overwrite: true,
    })
  })
})
