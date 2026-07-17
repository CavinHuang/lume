import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WikiView } from './WikiView'

describe('WikiView render smoke', () => {
  test('renders the independent Wiki shell before desktop data arrives', () => {
    const html = renderToStaticMarkup(<WikiView />)
    expect(html).toContain('知识归宿')
    expect(html).toContain('导入')
    expect(html).toContain('向 Wiki 提问')
    expect(html).toContain('还没有 Wiki 页面')
  })
})
