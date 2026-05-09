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
    expect(html).toContain('个人')
  })
})
