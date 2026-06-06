import { describe, expect, test } from 'bun:test'
import type { LumeConfigPermissionsSection } from '@lume/shared'
import {
  buildSystemToolPermissionsSection,
  buildSystemToolRows,
  findSystemToolGroup,
  toggleSystemToolGroupDeny,
} from './system-tools-state'

describe('system-tools-state', () => {
  test('builds rows from tool policy deny groups', () => {
    const rows = buildSystemToolRows(['group:runtime', 'group:reading'])

    expect(rows.find((row) => row.id === 'shell')).toMatchObject({
      enabled: false,
      locked: false,
      policyEntry: 'group:runtime',
    })
    expect(rows.find((row) => row.id === 'web')).toMatchObject({
      enabled: true,
      locked: false,
      policyEntry: 'group:web',
    })
    expect(rows.find((row) => row.id === 'file-read')).toMatchObject({
      enabled: true,
      locked: true,
    })
    expect(rows.find((row) => row.id === 'reading')).toMatchObject({
      enabled: false,
      locked: false,
      policyEntry: 'group:reading',
    })
  })

  test('toggles a system tool group without disturbing unrelated deny entries', () => {
    expect(toggleSystemToolGroupDeny(['Write'], 'group:runtime', false)).toEqual(['Write', 'group:runtime'])
    expect(toggleSystemToolGroupDeny(['Write', 'group:runtime'], 'group:runtime', false)).toEqual(['Write', 'group:runtime'])
    expect(toggleSystemToolGroupDeny(['Write', 'group:runtime', 'group:web'], 'group:runtime', true)).toEqual(['Write', 'group:web'])
  })

  test('builds the next permissions section while preserving existing rules and allow policy', () => {
    const current: LumeConfigPermissionsSection = {
      toolPolicy: {
        allow: ['Read'],
        deny: ['Write', 'group:runtime'],
      },
      rules: [{ tool: 'Bash', action: 'ask' }],
      classifier: { enabled: true },
    }
    const webGroup = findSystemToolGroup('web')

    expect(buildSystemToolPermissionsSection(current, webGroup, false)).toEqual({
      toolPolicy: {
        allow: ['Read'],
        deny: ['Write', 'group:runtime', 'group:web'],
      },
      rules: [{ tool: 'Bash', action: 'ask' }],
      classifier: { enabled: true },
    })
    expect(buildSystemToolPermissionsSection(current, findSystemToolGroup('shell'), true)).toEqual({
      toolPolicy: {
        allow: ['Read'],
        deny: ['Write'],
      },
      rules: [{ tool: 'Bash', action: 'ask' }],
      classifier: { enabled: true },
    })
  })

  test('does not mutate policy for locked groups', () => {
    const current: LumeConfigPermissionsSection = {
      toolPolicy: { deny: ['group:web'] },
    }

    expect(buildSystemToolPermissionsSection(current, findSystemToolGroup('file-read'), false)).toEqual(current)
  })
})
