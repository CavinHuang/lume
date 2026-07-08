import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LumeWelcomeSurface } from './LumeWelcomeSurface'
import { buildWelcomeSurfaceViewModel } from './welcome-surface-view-model'

describe('LumeWelcomeSurface', () => {
  test('renders the welcome hero for the selected workspace', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: 'Lume 主路径',
    })

    const html = renderToStaticMarkup(
      <LumeWelcomeSurface
        model={model}
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
        onRemovePendingFile={() => {}}
      />,
    )

    expect(html).toContain('今天想一起完成什么？')
    expect(html).toContain('在「Lume 主路径」中开始新的工作流')
  })

  test('locks workflow and composer interactions while sending', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: 'Lume 主路径',
    })

    const html = renderToStaticMarkup(
      <LumeWelcomeSurface
        model={model}
        workspaceSelector={<span>workspace-pill</span>}
        modelPicker={<span>model-pill</span>}
        composerModelPicker={<span>composer-model-pill</span>}
        permissionModePicker={<span>permission-pill</span>}
        thinkingLevelPicker={<span>thinking-pill</span>}
        editor={null}
        pendingFiles={[{ id: 'pending-1', filename: 'spec.md', mediaType: 'text/markdown', size: 7, sourcePath: 'C:/tmp/spec.md' }]}
        sending={true}
        hasText={true}
        onSend={() => {}}
        onAttach={() => {}}
        onRemovePendingFile={() => {}}
      />,
    )

    expect(html).toContain('data-welcome-lock="hero-controls"')
    expect(html).toContain('data-welcome-lock="composer"')
    expect(html).toContain('inert=""')
    expect(html).toMatch(/<button(?=[^>]*aria-label="添加")(?=[^>]*disabled="")[^>]*>/)
    expect(html).toMatch(/<button(?=[^>]*title="移除附件")(?=[^>]*disabled="")[^>]*>/)
  })

  test('renders welcome suggestions', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: 'Lume 主路径',
    })

    const html = renderToStaticMarkup(
      <LumeWelcomeSurface
        model={model}
        workspaceSelector={<span>workspace-pill</span>}
        modelPicker={<span>model-pill</span>}
        composerModelPicker={<span>composer-model-pill</span>}
        permissionModePicker={<span>permission-pill</span>}
        thinkingLevelPicker={<span>thinking-pill</span>}
        editor={null}
        pendingFiles={[]}
        sending={false}
        hasText={false}
        suggestions={[{ id: 's1', title: '规划今天', prompt: '帮我规划今天。' }]}
        onSend={() => {}}
        onAttach={() => {}}
        onRemovePendingFile={() => {}}
      />,
    )

    expect(html).toContain('规划今天')
    expect(html).toContain('帮我规划今天。')
  })
})
