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
})
