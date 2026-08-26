import { describe, expect, test } from 'bun:test'
import { LUME_BROWSER_TOOL_NAMES } from '@lume/shared'
import { BROWSER_TOOL_LABELS, BROWSER_TOOL_PREFIX, displayToolName } from './tool-summary'

/**
 * #601 维护性 review:sidecar 注册表（真源 @lume/shared LUME_BROWSER_TOOL_NAMES）
 * 与 web 展示映射 BROWSER_TOOL_LABELS 是三方字符串契约——sidecar 加新工具时
 * web 映射会静默退化为英文原名，此哨兵把人肉防线换成 CI 防线。
 */
describe('browser 工具名三方契约哨兵', () => {
  test('web 映射表键集与 shared 真源双向相等', () => {
    const registered = [...LUME_BROWSER_TOOL_NAMES].sort()
    const mapped = Object.keys(BROWSER_TOOL_LABELS).sort()
    expect(mapped).toEqual(registered)
  })

  test('每个注册工具的展示名都完成中文化（不退化为原始名/裸动作名）', () => {
    for (const name of LUME_BROWSER_TOOL_NAMES) {
      const full = `${BROWSER_TOOL_PREFIX}${name}`
      const display = displayToolName(full)
      expect(display.startsWith('浏览器 · ')).toBeTrue()
      expect(display.endsWith(name)).toBeFalse()
    }
  })
})
