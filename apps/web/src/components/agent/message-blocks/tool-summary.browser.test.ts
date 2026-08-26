import { describe, expect, test } from 'bun:test'
import { displayToolName, summarizeInput } from './tool-summary'

describe('#601 browser tool display', () => {
  test('displayToolName 去前缀并映射中文动作名', () => {
    expect(displayToolName('mcp__browser__click')).toBe('浏览器 · 点击')
    expect(displayToolName('mcp__browser__navigate')).toBe('浏览器 · 打开网页')
    expect(displayToolName('mcp__browser__unknown_action')).toBe('浏览器 · unknown_action')
    // 非 browser 工具原样返回
    expect(displayToolName('Bash')).toBe('Bash')
  })

  test('summarizeInput 对浏览器动作产出语义摘要', () => {
    expect(summarizeInput({ url: 'https://example.com/some/path' }, 'mcp__browser__navigate'))
      .toBe('打开网页 example.com/some/path')
    expect(summarizeInput({ ref: 'e12', label: '搜索按钮' }, 'mcp__browser__click'))
      .toBe('点击 @e12(搜索按钮)')
    // 模型可能传带 @ 的 ref，不得产出双前缀
    expect(summarizeInput({ ref: '@e12' }, 'mcp__browser__click'))
      .toBe('点击 @e12')
    expect(summarizeInput({ key: 'Enter' }, 'mcp__browser__press'))
      .toBe('按键 Enter')
    // 无可识别字段时退化为动作名
    expect(summarizeInput({}, 'mcp__browser__scroll')).toBe('滚动页面')
    // scroll 按 delta_y 符号给方向
    expect(summarizeInput({ delta_y: -600, ref: 'e1' }, 'mcp__browser__scroll')).toBe('滚动页面 向上 @e1')
    expect(summarizeInput({ delta_y: 600 }, 'mcp__browser__scroll')).toBe('滚动页面 向下')
    // check 兼作取消勾选
    expect(summarizeInput({ ref: 'e5', checked: false }, 'mcp__browser__check')).toBe('取消勾选 @e5')
    expect(summarizeInput({ ref: 'e5' }, 'mcp__browser__check')).toBe('勾选 @e5')
  })

  test('#601 review:fill/type 只显长度不摘录明文（防密码进聊天流）', () => {
    const summary = summarizeInput({ ref: 'e3', text: 'P@ssw0rd123' }, 'mcp__browser__type')
    expect(summary).toContain('@e3')
    expect(summary).toContain('已输入 11 字符')
    expect(summary).not.toContain('P@ssw0rd123')
  })

  test('非浏览器工具不受影响', () => {
    expect(summarizeInput({ command: 'bun test' })).toBe('bun test')
    expect(summarizeInput({})).toBe('正在执行工具调用')
  })
})
