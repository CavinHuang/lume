import { describe, expect, test } from 'bun:test'
import type { LumeEffectiveConfig } from '@lume/shared'
import {
  buildPermissionsSectionFromRuleDrafts,
  buildPermissionScopeOptions,
  buildPermissionSettingsDraft,
  createPermissionRuleDraft,
  formatPermissionScopeLabel,
  normalizePermissionRuleDrafts,
} from './permission-settings-state'

describe('permission settings state', () => {
  test('builds permission scope options with global default first', () => {
    const options = buildPermissionScopeOptions([
      { id: 'workspace-1', slug: 'lume-core', name: 'Lume Core', createdAt: 1, updatedAt: 2 },
      { id: 'workspace-2', slug: 'wechat-bot', name: '微信机器人', createdAt: 3, updatedAt: 4 },
    ])

    expect(options).toEqual([
      { value: '__global__', label: '全局默认', description: '所有工作区的基础权限' },
      { value: 'lume-core', label: 'Lume Core', description: '工作区覆盖: lume-core' },
      { value: 'wechat-bot', label: '微信机器人', description: '工作区覆盖: wechat-bot' },
    ])
    expect(formatPermissionScopeLabel(options, 'wechat-bot')).toBe('微信机器人')
    expect(formatPermissionScopeLabel(options, 'missing')).toBe('missing')
  })

  test('builds an editable default permission draft from effective config', () => {
    const draft = buildPermissionSettingsDraft({
      version: 1,
      sourcePath: '/tmp/lume.yaml',
      agent: { permissionMode: 'plan' },
      permissions: {
        toolPolicy: {
          allow: ['Read', 'Bash'],
          deny: ['Write']
        },
        rules: [
          { id: 'ask-bash', tool: 'Bash', action: 'ask', commandPattern: 'npm\\s+install' }
        ],
        classifier: { enabled: true },
        privateWriteRoots: ['.lume', '.lume/artifacts']
      }
    } satisfies LumeEffectiveConfig)

    expect(draft.permissionMode).toBe('plan')
    expect(draft.rules).toEqual([
      { id: 'ask-bash', action: 'ask', tool: 'Bash', commandPattern: 'npm\\s+install', pathPattern: '', scope: undefined },
    ])
  })

  test('normalizes editable permission rules', () => {
    expect(normalizePermissionRuleDrafts([
      createPermissionRuleDraft(),
      { action: 'allow', tool: ' Bash ', commandPattern: ' git\\s+status ', pathPattern: '', scope: undefined },
      { action: 'deny', tool: 'Write', commandPattern: '', pathPattern: ' src/** ', scope: undefined },
    ])).toEqual([
      { action: 'allow', tool: 'Bash', commandPattern: 'git\\s+status' },
      { action: 'deny', tool: 'Write', pathPattern: 'src/**' },
    ])
  })

  test('builds saved permissions without overwriting tool visibility policy', () => {
    expect(buildPermissionsSectionFromRuleDrafts({
      toolPolicy: {
        allow: ['Read'],
        deny: ['group:web'],
      },
      classifier: { enabled: true },
    }, [
      { action: 'ask', tool: ' Bash ', commandPattern: ' npm\\s+install ', pathPattern: '', scope: undefined },
    ])).toEqual({
      toolPolicy: {
        allow: ['Read'],
        deny: ['group:web'],
      },
      classifier: { enabled: true },
      rules: [
        { action: 'ask', tool: 'Bash', commandPattern: 'npm\\s+install' },
      ],
    })
  })
})
