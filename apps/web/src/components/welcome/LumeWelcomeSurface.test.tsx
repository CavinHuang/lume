import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LumeWelcomeSurface } from './LumeWelcomeSurface'
import { buildWelcomeSurfaceViewModel } from './welcome-surface-view-model'

describe('LumeWelcomeSurface', () => {
  test('renders lower panels by panel id instead of array position', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: 'Lume 主路径',
      recentThreads: [],
      recentFiles: [],
    })

    const reorderedModel = {
      ...model,
      lowerPanels: [
        model.lowerPanels[2],
        model.lowerPanels[0],
        model.lowerPanels[1],
      ],
    }

    const html = renderToStaticMarkup(
      <LumeWelcomeSurface
        model={reorderedModel}
        workspaceSelector={<span>workspace-pill</span>}
        modelPicker={<span>model-pill</span>}
        composerModelPicker={<span>composer-model-pill</span>}
        permissionModePicker={<span>permission-pill</span>}
        thinkingLevelPicker={<span>thinking-pill</span>}
        editor={null}
        pendingFiles={[]}
        sending={false}
        hasText={false}
        onSend={() => {}}
        onAttach={() => {}}
        onOpenThread={() => {}}
        onChoosePromptSeed={() => {}}
        onRemovePendingFile={() => {}}
      />,
    )

    expect(html).toContain('最近会话')
    expect(html).toContain('还没有最近会话，从下方输入区开始一次新的协作。')
    expect(html).toContain('推荐工作流')
    expect(html).toContain('最近文件')
  })

  test('locks workflow and composer interactions while sending', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: 'Lume 主路径',
      recentThreads: [],
      recentFiles: [{ filename: 'spec.md', sourcePath: 'C:/tmp/spec.md' }],
    })

    const html = renderToStaticMarkup(LumeWelcomeSurface({
      model,
      workspaceSelector: <span>workspace-pill</span>,
      modelPicker: <span>model-pill</span>,
      composerModelPicker: <span>composer-model-pill</span>,
      permissionModePicker: <span>permission-pill</span>,
      thinkingLevelPicker: <span>thinking-pill</span>,
      editor: null,
      pendingFiles: [{ filename: 'spec.md', sourcePath: 'C:/tmp/spec.md' }],
      sending: true,
      hasText: true,
      onSend() {},
      onAttach() {},
      onOpenThread() {},
      onChoosePromptSeed() {},
      onRemovePendingFile() {},
    }))
    const workflowItems = model.lowerPanels.find((panel) => panel.id === 'recommended-workflows')?.items ?? []
    const disabledWorkflowButtons = workflowItems.filter((item) =>
      new RegExp(`<button type="button" disabled=""[^>]*>[\\s\\S]*?${item.title}[\\s\\S]*?<\\/button>`).test(html),
    )

    expect(html).toContain('data-welcome-lock="hero-controls"')
    expect(html).toContain('data-welcome-lock="composer"')
    expect(html).toContain('inert=""')
    expect(html).toMatch(/<button type="button" aria-label="添加文件" title="添加文件" disabled=""/)
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>×<\/button>/)
    expect(disabledWorkflowButtons).toHaveLength(workflowItems.length)
  })
})
