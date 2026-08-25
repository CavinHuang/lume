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
    const rows = buildSystemToolRows(['group:runtime', 'group:data', 'group:reading'])

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
    expect(rows.find((row) => row.id === 'data')).toMatchObject({
      label: '数据查询',
      description: '股份行情、天气预报、IP 归属地等专业数据',
      count: 4,
      enabled: false,
      locked: false,
      policyEntry: 'group:data',
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

  test('keeps session task management locked while scheduled task mutation stays toggleable', () => {
    const rows = buildSystemToolRows(['group:automation'])

    expect(rows.find((row) => row.id === 'task')).toMatchObject({
      label: '任务',
      description: '会话任务列表管理',
      count: 5,
      enabled: true,
      locked: true,
    })
    expect(rows.find((row) => row.id === 'automation')).toMatchObject({
      label: '定时任务',
      description: 'AI 创建和管理定时执行的任务',
      count: 1,
      enabled: false,
      locked: false,
      policyEntry: 'group:automation',
    })
  })

  test('keeps user interaction controls visible as locked core tools', () => {
    const rows = buildSystemToolRows(['group:planning'])
    const row = rows.find((item) => item.id === 'user-interaction')

    expect(row).toMatchObject({
      label: '用户交互',
      description: 'Plan 模式切换与用户提问',
      count: 2,
      enabled: true,
      locked: true,
    })
    expect('policyEntry' in row!).toBe(false)
  })

  test('counts the locked Agent group as sub-agent dispatch plus skill invocation', () => {
    const rows = buildSystemToolRows()

    expect(rows.find((row) => row.id === 'agent')).toMatchObject({
      label: 'Agent',
      description: '子 Agent 调度与技能调用',
      count: 2,
      enabled: true,
      locked: true,
    })
  })

  test('keeps UI self-evolution tools toggleable', () => {
    const rows = buildSystemToolRows(['group:evolution'])

    expect(rows.find((row) => row.id === 'evolution')).toMatchObject({
      label: '自进化',
      description: 'AI 自主定制页面、Widget、UI 外观',
      count: 1,
      enabled: false,
      locked: false,
      policyEntry: 'group:evolution',
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
