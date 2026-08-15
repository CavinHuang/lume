import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getDefaultStore } from 'jotai'
import type { FileRef } from '@lume/shared'

const { FilesRightPanelWorkspace } = await import('./FilesRightPanelWorkspace')
const { createThreadFileWorkspace, previewFileTab, openFileTab } = await import('./right-panel-files-state')
const { rightPanelFileLayoutPreferencesAtom } = await import('@/atoms')

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

function setNarrowShowsPreview(value: boolean) {
  getDefaultStore().set(rightPanelFileLayoutPreferencesAtom, { treeWidth: 260, narrowShowsPreview: value })
}

describe('FilesRightPanelWorkspace narrow-mode layout (preference-driven)', () => {
  // 窄模式树/预览二态由 narrowShowsPreview 偏好驱动，与 activeItem 无关
  test('previewTab 设置后默认(narrowShowsPreview=false)仍显示树, 预览 hidden', () => {
    setNarrowShowsPreview(false)
    const markup = renderNarrow(previewFileTab(createThreadFileWorkspace({ fileContextId: 'ctx' }), ref))
    expect(markup).toMatch(/class="relative min-h-0 shrink-0 [^"]*"/)
    expect(markup).toMatch(/class="[^"]*min-h-0 min-w-0 flex-1 flex-col[^"]*hidden"/)
    expect(markup).not.toContain('返回文件树')
  })

  test('narrowShowsPreview=true: previewTab 时预览占满且头部有返回树按钮', () => {
    setNarrowShowsPreview(true)
    const markup = renderNarrow(previewFileTab(createThreadFileWorkspace({ fileContextId: 'ctx' }), ref))
    expect(markup).toMatch(/class="relative min-h-0 shrink-0 [^"]*hidden"/)
    expect(markup).toMatch(/class="flex min-h-0 min-w-0 flex-1 flex-col"/)
    expect(markup).toContain('title="返回文件树"')
  })

  test('narrowShowsPreview=true: 正式 tab 同样预览占满且有返回树按钮', () => {
    setNarrowShowsPreview(true)
    const markup = renderNarrow(openFileTab(createThreadFileWorkspace({ fileContextId: 'ctx' }), ref))
    expect(markup).toMatch(/class="relative min-h-0 shrink-0 [^"]*hidden"/)
    expect(markup).toContain('title="返回文件树"')
  })
})
