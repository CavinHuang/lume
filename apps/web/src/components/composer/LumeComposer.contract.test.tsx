import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LumeComposer } from './LumeComposer'
import { deriveLumeComposerState } from './lume-composer-state'

function ComposerContractHarness({
  hasText,
  mode,
}: {
  hasText: boolean
  mode: 'idle' | 'busy' | 'streaming'
}) {
  const composerState = deriveLumeComposerState({ hasText, mode })

  return (
    <LumeComposer
      tone={composerState.tone}
      editorSlot={<div>editor</div>}
      actionSlot={
        composerState.showStop ? (
          <button type="button">停止</button>
        ) : composerState.showBusy ? (
          <div>正在发送</div>
        ) : (
          <button type="button" disabled={!composerState.canSend}>
            发送
          </button>
        )
      }
    />
  )
}

describe('LumeComposer contract', () => {
  test('busy mode keeps streaming tone without rendering a stop affordance', () => {
    const html = renderToStaticMarkup(
      <ComposerContractHarness hasText={false} mode="busy" />,
    )

    expect(html).toContain('data-tone="streaming"')
    expect(html).toContain('正在发送')
    expect(html).not.toContain('停止')
  })

  test('streaming mode renders the stop affordance', () => {
    const html = renderToStaticMarkup(
      <ComposerContractHarness hasText={true} mode="streaming" />,
    )

    expect(html).toContain('data-tone="streaming"')
    expect(html).toContain('停止')
    expect(html).not.toContain('正在发送')
  })

  test('keeps trailing tools and action in the same right-side group', () => {
    const html = renderToStaticMarkup(
      <LumeComposer
        tone="idle"
        editorSlot={<div>editor</div>}
        leadingTools={<button type="button">model</button>}
        trailingTools={<button type="button">context</button>}
        actionSlot={<button type="button">send</button>}
      />,
    )

    expect(html).toContain('data-composer-right-tools="true"')
    expect(html.indexOf('context')).toBeLessThan(html.indexOf('send'))
  })
})
