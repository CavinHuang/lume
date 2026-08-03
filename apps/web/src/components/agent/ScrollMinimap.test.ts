import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('ScrollMinimap hook order', () => {
  test('declares bar hover hooks before the conditional hidden return', () => {
    const source = readFileSync(resolve(import.meta.dir, 'ScrollMinimap.tsx'), 'utf-8')

    const hiddenReturn = source.indexOf('if (items.length < MIN_ITEMS || !canScroll) return null')
    const handleBarsMouseMove = source.indexOf('const handleBarsMouseMove = React.useCallback')

    expect(hiddenReturn).toBeGreaterThan(-1)
    expect(handleBarsMouseMove).toBeGreaterThan(-1)
    expect(handleBarsMouseMove).toBeLessThan(hiddenReturn)
  })

  test('keeps the preview card interactive so hover does not collapse when moving off the rail', () => {
    const source = readFileSync(resolve(import.meta.dir, 'ScrollMinimap.tsx'), 'utf-8')

    expect(source).toContain('pointer-events-auto')
    expect(source).toContain('handlePanelMouseEnter')
    expect(source).toContain('handlePanelMouseLeave')
    expect(source).toContain('onMouseEnter={handlePanelMouseEnter}')
    expect(source).toContain('onMouseLeave={handlePanelMouseLeave}')
  })

  test('ripples width from the focus index while keeping height uniform', () => {
    const source = readFileSync(resolve(import.meta.dir, 'ScrollMinimap.tsx'), 'utf-8')

    expect(source).toContain('const BAR_HEIGHT')
    expect(source).toContain('flex h-2.5 w-full shrink-0 items-center justify-end')
    expect(source).toContain('const BAR_WIDTH_FOCUS')
    expect(source).toContain('const BAR_WIDTH_BASE')
    expect(source).toContain('barWidthForDistance')
    expect(source).toContain('isHovering ? barWidthForDistance(distance) : BAR_WIDTH_BASE')
    expect(source).toContain('transition-[width,background-color]')
    expect(source).toContain("'bg-foreground'")
    expect(source).toContain('bg-foreground/60')
    expect(source).toContain('bg-foreground/40')

    expect(source).not.toContain('BASE_BAR_WIDTH')
    expect(source).not.toContain('ACTIVE_BAR_WIDTH')
    expect(source).not.toContain('NEARBY_BAR_WIDTH')
  })

  test('anchors the rail against the far right edge, with the preview card offset to its left', () => {
    const source = readFileSync(resolve(import.meta.dir, 'ScrollMinimap.tsx'), 'utf-8')

    expect(source).toContain('const PREVIEW_CARD_WIDTH')
    expect(source).toContain('const RAIL_RIGHT_INSET')
    expect(source).toContain('const PREVIEW_GAP')
    expect(source).toContain('paddingRight: RAIL_RIGHT_INSET')
    expect(source).toContain('right: `${MINIMAP_HIT_WIDTH + PREVIEW_GAP + RAIL_RIGHT_INSET}px`')
  })

  test('renders one anchor per minimap item instead of inventing dense filler slots', () => {
    const source = readFileSync(resolve(import.meta.dir, 'ScrollMinimap.tsx'), 'utf-8')

    expect(source).toContain('items.map((item, i) =>')
    expect(source).toContain('flex h-2.5 w-full shrink-0 items-center justify-end')
    expect(source).toContain('getBarIndex(e.clientY, e.currentTarget, items.length)')
    expect(source).not.toContain('DENSE_RAIL_BAR_COUNT')
    expect(source).not.toContain('MAX_RAIL_BAR_COUNT')
    expect(source).not.toContain('slotToItemIndex')
    expect(source).not.toContain('itemToSlotIndex')
    expect(source).not.toContain('mappedSlotIndices')
  })
})
