import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MentionList } from './MentionList'

describe('MentionList', () => {
  test('renders grouped slash sections with quick actions and skills', () => {
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

    expect(html).toContain('gap-0.5')
    expect(html).toContain('p-2')
    expect(html).toContain('pr-1')
    expect(html).toContain('text-[12px]')
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

    expect(html).toContain('Agents &amp; Files')
    expect(html).toContain('Agents')
    expect(html).toContain('Files')
    expect(html.indexOf('江岚 · 作家')).toBeLessThan(html.indexOf('brief.md'))
  })
})
