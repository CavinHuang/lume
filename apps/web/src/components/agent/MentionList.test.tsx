import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MentionList } from './MentionList'

describe('MentionList', () => {
  test('renders grouped slash command rows without source icons', () => {
    const html = renderToStaticMarkup(
      <MentionList
        trigger="/"
        items={[
          { id: 'clear', label: 'clear', type: 'command', title: '/clear', subtitle: '清空当前对话上下文', section: 'capability' },
          { id: 'debug', label: 'debug', type: 'skill', title: '/debug', subtitle: 'Investigate runtime failures', section: 'skill' },
        ]}
        command={() => {}}
      />,
    )

    expect(html).toContain('rounded-[10px]')
    expect(html).toContain('h-9')
    expect(html).toContain('rounded-[6px]')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('继续输入以搜索命令、技能与插件')
    expect(html).not.toContain('size-[22px]')
    expect(html).toContain('动作')
    expect(html).toContain('技能')
    expect(html).toContain('/clear')
    expect(html).toContain('/debug')
  })

  test('renders @ agents ahead of file mentions', () => {
    const html = renderToStaticMarkup(
      <MentionList
        trigger="@"
        items={[
          {
            id: 'writer',
            label: 'writer',
            type: 'agent',
            title: '江岚 · 作家',
            subtitle: '长文写作、品牌文案、文章结构和报告表达。',
            section: 'agent',
            meta: '前台',
          },
          {
            id: 'brief.md',
            label: 'brief.md',
            type: 'file',
            section: 'file',
          },
        ]}
        command={() => {}}
      />,
    )

    expect(html).toContain('继续输入以搜索 Agent、连接账户与文件')
    expect(html).toContain('size-[22px]')
    expect(html).not.toContain('引用上下文')
    expect(html).toContain('Agents')
    expect(html).toContain('Files')
    expect(html.indexOf('江岚 · 作家')).toBeLessThan(html.indexOf('brief.md'))
  })

})
