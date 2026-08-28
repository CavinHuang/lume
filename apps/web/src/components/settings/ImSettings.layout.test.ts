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

  test('#544 renders a dedicated mirror switch per account row with unique aria label', () => {
    expect(source).toContain('aria-label={`会话镜像-${account.label}`}')
    expect(source).toContain('resolveImMirrorSwitchState')
    expect(source).toContain('onToggleMirror')
  })

  test('#544 shows an owner summary line and mirror hint slot inside account rows', () => {
    expect(source).toContain('会话镜像已开启')
    expect(source).toContain('formatImMirrorRowHint')
  })

  test('#544 attach: per-account attach panel pairs an existing group with a desktop thread', () => {
    expect(source).toContain('listImMirrorAttachCandidates')
    expect(source).toContain('attachImMirror')
    expect(source).toContain('detachImMirror')
    expect(source).toContain('附着已有群')
    expect(source).toContain('解除附着')
    expect(source).toContain("IM_MIRROR_TIERS[account.provider].tier === 'attach'")
  })
})
