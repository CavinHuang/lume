import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FileRef } from '@lume/shared'

const { FilesRightPanelWorkspace } = await import('./FilesRightPanelWorkspace')
const { createThreadFileWorkspace, previewFileTab, openFileTab } = await import('./right-panel-files-state')

const ref: FileRef = { source: 'session', scopeId: 'ctx', relativePath: 'notes/a.md' }

// SSR 渲染不跑 ResizeObserver，containerWidth 恒 0 → 恒为窄模式（wide=false）
function renderNarrow(workspace: ReturnType<typeof createThreadFileWorkspace>) {
  return renderToStaticMarkup(
    <FilesRightPanelWorkspace
      threadId="t1"
      workspace={workspace}
      openFunctions={['files']}
      onWorkspaceChange={() => {}}
    />,
  )
}

describe('FilesRightPanelWorkspace narrow-mode layout', () => {
  test('files function view: tree visible, preview hidden', () => {
    const markup = renderNarrow(createThreadFileWorkspace({ fileContextId: 'ctx' }))
    expect(markup).toMatch(/class="relative min-h-0 shrink-0 [^"]*"/)
    expect(markup).toMatch(/class="min-h-0 min-w-0 flex-1 hidden"/)
  })

  test('formal file tab: tree hidden, preview visible', () => {
    const markup = renderNarrow(openFileTab(createThreadFileWorkspace({ fileContextId: 'ctx' }), ref))
    expect(markup).toMatch(/class="relative min-h-0 shrink-0 [^"]*hidden"/)
    expect(markup).toMatch(/class="min-h-0 min-w-0 flex-1"/)
  })

  // 回归：窄模式单击文件走 file-preview，预览容器必须可见（曾因 showTree 恒 true 被隐藏）
  test('preview tab (single-click): tree hidden, preview visible', () => {
    const markup = renderNarrow(previewFileTab(createThreadFileWorkspace({ fileContextId: 'ctx' }), ref))
    expect(markup).toMatch(/class="relative min-h-0 shrink-0 [^"]*hidden"/)
    expect(markup).not.toMatch(/class="min-h-0 min-w-0 flex-1 hidden"/)
  })
})
