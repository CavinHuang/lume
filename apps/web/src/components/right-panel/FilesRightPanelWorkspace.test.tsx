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
  // 临时预览由偏好驱动；正式 tab 始终优先显示内容。
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
    // 断言头部容器（与返回按钮同一条件渲染，纯 HTML 不受其他测试文件 mock Button 影响）
    expect(markup).toContain('flex h-9 shrink-0 items-center gap-2 border-b')
    expect(markup).toContain('flex h-10 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b')
  })

  test('正式 tab 无视 narrowShowsPreview=false，仍让预览占满并显示返回树按钮', () => {
    setNarrowShowsPreview(false)
    const markup = renderNarrow(openFileTab(createThreadFileWorkspace({ fileContextId: 'ctx' }), ref))
    expect(markup).toMatch(/class="relative min-h-0 shrink-0 [^"]*hidden"/)
    expect(markup).toContain('flex h-9 shrink-0 items-center gap-2 border-b')
    expect(markup).toContain('flex h-10 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b')
  })

  test('无名称 MCP 资源在窄预览头部回退显示 URI', () => {
    setNarrowShowsPreview(true)
    const workspace = previewFileTab(createThreadFileWorkspace({}), {
      kind: 'mcp-resource',
      workspaceSlug: 'demo',
      resource: { serverId: 'docs', serverName: 'Docs', uri: 'docs://guide' },
    })
    const markup = renderNarrow(workspace)
    expect(markup).toContain('>docs://guide</span>')
  })
})
