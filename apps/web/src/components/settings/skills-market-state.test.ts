import { describe, expect, test } from 'bun:test'
import type { SkillCatalogItem } from '@lume/shared'
import {
  buildInstalledSections,
  buildTrustMeta,
  filterCatalogItems,
  sortCatalogItems,
} from './skills-market-state'

function makeItem(
  input: Partial<SkillCatalogItem> & Pick<SkillCatalogItem, 'id' | 'slug' | 'name' | 'sourceType' | 'trustLevel' | 'installState'>
): SkillCatalogItem {
  return {
    ...input,
  }
}

describe('sortCatalogItems', () => {
  test('sorts trusted built-in items before github review-required items', () => {
    const items = sortCatalogItems([
      makeItem({
        id: 'github:prompt-library',
        slug: 'prompt-library',
        name: 'Prompt Library',
        sourceType: 'github',
        trustLevel: 'review-required',
        installState: 'not-installed',
      }),
      makeItem({
        id: 'built-in:skill-installer',
        slug: 'skill-installer',
        name: 'Skill Installer',
        sourceType: 'built-in',
        trustLevel: 'trusted',
        installState: 'installed',
      }),
    ])

    expect(items.map((item) => item.slug)).toEqual(['skill-installer', 'prompt-library'])
  })
})

describe('buildInstalledSections', () => {
  test('builds installed sections from install state and source type', () => {
    const sections = buildInstalledSections([
      makeItem({
        id: 'built-in:skill-installer',
        slug: 'skill-installer',
        name: 'Skill Installer',
        sourceType: 'built-in',
        trustLevel: 'trusted',
        installState: 'installed',
      }),
      makeItem({
        id: 'github:prompt-library',
        slug: 'prompt-library',
        name: 'Prompt Library',
        sourceType: 'github',
        trustLevel: 'review-required',
        installState: 'installed',
      }),
      makeItem({
        id: 'local:powerpoint',
        slug: 'powerpoint',
        name: 'PowerPoint',
        sourceType: 'local',
        trustLevel: 'trusted',
        installState: 'not-installed',
      }),
    ])

    expect(sections.installed.map((item) => item.slug)).toEqual(['skill-installer', 'prompt-library'])
    expect(sections.reviewRequired.map((item) => item.slug)).toEqual(['prompt-library'])
  })
})

describe('filterCatalogItems', () => {
  test('filters by search text and source type', () => {
    const items = filterCatalogItems(
      [
        makeItem({
          id: 'built-in:skill-installer',
          slug: 'skill-installer',
          name: 'Skill Installer',
          sourceType: 'built-in',
          trustLevel: 'trusted',
          installState: 'installed',
        }),
        makeItem({
          id: 'github:prompt-library',
          slug: 'prompt-library',
          name: 'Prompt Library',
          sourceType: 'github',
          trustLevel: 'review-required',
          installState: 'not-installed',
        }),
      ],
      { query: 'prompt', sourceType: 'github' }
    )

    expect(items.map((item) => item.slug)).toEqual(['prompt-library'])
  })
})

describe('buildTrustMeta', () => {
  test('maps trust levels to badge tone and copy', () => {
    expect(buildTrustMeta('trusted')).toEqual({
      label: 'Trusted',
      badgeVariant: 'secondary',
      toneClass: 'text-emerald-700',
    })
    expect(buildTrustMeta('review-required')).toEqual({
      label: 'Review Required',
      badgeVariant: 'outline',
      toneClass: 'text-amber-700',
    })
  })
})
