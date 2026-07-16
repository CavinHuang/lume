import { afterEach, describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import * as threadItemActionsModule from './ThreadItemActions'

const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval

afterEach(() => {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
})

describe('ThreadItemActions', () => {
  test('相对时间每分钟触发刷新并在卸载时停止', () => {
    let tick: (() => void) | undefined
    let clearedTimer: unknown
    globalThis.setInterval = ((callback: () => void, delay: number) => {
      tick = callback
      expect(delay).toBe(60_000)
      return 7
    }) as typeof setInterval
    globalThis.clearInterval = ((timer: unknown) => {
      clearedTimer = timer
    }) as typeof clearInterval

    const subscribe = (threadItemActionsModule as {
      subscribeToRelativeTimeUpdates?: (onUpdate: () => void) => () => void
    }).subscribeToRelativeTimeUpdates
    expect(subscribe).toBeFunction()

    const onUpdate = mock()
    const unsubscribe = subscribe!(onUpdate)
    tick?.()
    expect(onUpdate).toHaveBeenCalledTimes(1)

    unsubscribe()
    expect(clearedTimer).toBe(7)
  })

  test('时间标签保留单行所需宽度', () => {
    const markup = renderToStaticMarkup(
      <threadItemActionsModule.ThreadItemActions
        updatedAt={0}
        menuItems={() => null}
      />,
    )

    expect(markup).toContain('min-w-[42px]')
    expect(markup).toContain('whitespace-nowrap')
  })
})
