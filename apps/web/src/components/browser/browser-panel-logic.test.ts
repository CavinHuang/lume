import { describe, expect, test } from 'bun:test'
import {
  CLOSED_TAB_RING_LIMIT,
  decomposeDesktopZoom,
  desktopZoomFactorFromLevel,
  estimateTabStripWidthPx,
  formatRelativeTime,
  IDENTITY_ZOOM_COMPENSATION,
  isCertificateErrorCode,
  isTabStripOverflowing,
  matchesTabQuery,
  pushClosedTabRing,
  reorderedByIds,
  type ClosedTabEntry,
} from './browser-panel-logic'

describe('estimateTabStripWidthPx / isTabStripOverflowing(ZCode Xkt 估宽)', () => {
  test('tabs*60px + (tabs-1)*8px;0 与负数计 0', () => {
    expect(estimateTabStripWidthPx(0)).toBe(0)
    expect(estimateTabStripWidthPx(1)).toBe(60)
    expect(estimateTabStripWidthPx(3)).toBe(3 * 60 + 2 * 8)
    expect(estimateTabStripWidthPx(-2)).toBe(0)
  })

  test('溢出判定:估宽超过 viewport 即溢出,viewport 未知(0)不判溢出', () => {
    expect(isTabStripOverflowing(3, estimateTabStripWidthPx(3))).toBe(false)
    expect(isTabStripOverflowing(3, estimateTabStripWidthPx(3) - 1)).toBe(true)
    expect(isTabStripOverflowing(5, 0)).toBe(false)
  })
})

describe('reorderedByIds(ZCode Ade 重排)', () => {
  test('全量排列按新序返回', () => {
    expect(reorderedByIds(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
    expect(reorderedByIds(['a', 'b'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  test('长度不符或含未知 id → null(调用方保持原序)', () => {
    expect(reorderedByIds(['a', 'b'], ['a'])).toBeNull()
    expect(reorderedByIds(['a', 'b'], ['a', 'b', 'c'])).toBeNull()
    expect(reorderedByIds(['a', 'b'], ['a', 'x'])).toBeNull()
  })
})

describe('pushClosedTabRing(ZCode Xde=8 最近关闭环)', () => {
  const entry = (id: string): ClosedTabEntry => ({ id, title: id, url: null, faviconUrl: null, closedAt: 0 })

  test('新条目置顶', () => {
    const next = pushClosedTabRing([entry('a')], entry('b'))
    expect(next.map((item) => item.id)).toEqual(['b', 'a'])
  })

  test('超出 8 条从尾部丢弃', () => {
    let ring: ClosedTabEntry[] = []
    for (let index = 0; index < CLOSED_TAB_RING_LIMIT + 3; index += 1) {
      ring = pushClosedTabRing(ring, entry(`t${index}`))
    }
    expect(ring).toHaveLength(CLOSED_TAB_RING_LIMIT)
    expect(ring[0]?.id).toBe(`t${CLOSED_TAB_RING_LIMIT + 2}`)
    expect(ring.at(-1)?.id).toBe(`t3`)
  })
})

describe('formatRelativeTime(总览/重开菜单相对时间)', () => {
  const now = Date.parse('2026-08-30T12:00:00Z')
  test('分桶:刚刚/分钟/小时/天', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
  })

  test('未来时间戳按 0 处理', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('刚刚')
  })
})

describe('desktopZoomFactorFromLevel(ZCode xEt:1.1^clamp(round,-3,5))', () => {
  test('档位折算与 clamp', () => {
    expect(desktopZoomFactorFromLevel(0)).toBe(1)
    expect(desktopZoomFactorFromLevel(1)).toBeCloseTo(1.1)
    expect(desktopZoomFactorFromLevel(1.4)).toBeCloseTo(1.1)
    expect(desktopZoomFactorFromLevel(1.6)).toBeCloseTo(1.21)
    expect(desktopZoomFactorFromLevel(-4)).toBeCloseTo(1.1 ** -3)
    expect(desktopZoomFactorFromLevel(6)).toBeCloseTo(1.1 ** 5)
  })

  test('非有限输入回 1', () => {
    expect(desktopZoomFactorFromLevel(Number.NaN)).toBe(1)
    expect(desktopZoomFactorFromLevel(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('decomposeDesktopZoom(ZCode VTt 布局/变换分解)', () => {
  test('desktopZoom<1 → layoutScale=1/z, transformScale=z', () => {
    expect(decomposeDesktopZoom(0.8)).toEqual({ layoutScale: 1.25, transformScale: 0.8 })
    expect(decomposeDesktopZoom(0.5)).toEqual({ layoutScale: 2, transformScale: 0.5 })
  })

  test('desktopZoom>=1 恒等;非法值回恒等', () => {
    expect(decomposeDesktopZoom(1)).toBe(IDENTITY_ZOOM_COMPENSATION)
    expect(decomposeDesktopZoom(1.5)).toBe(IDENTITY_ZOOM_COMPENSATION)
    expect(decomposeDesktopZoom(0)).toBe(IDENTITY_ZOOM_COMPENSATION)
    expect(decomposeDesktopZoom(Number.NaN)).toBe(IDENTITY_ZOOM_COMPENSATION)
  })
})

describe('isCertificateErrorCode(ZCode Wr:ERR_CERT_* = -217..-200)', () => {
  test('区间命中', () => {
    expect(isCertificateErrorCode(-200)).toBe(true)
    expect(isCertificateErrorCode(-217)).toBe(true)
    expect(isCertificateErrorCode(-202)).toBe(true)
  })

  test('区间外与非数值不命中', () => {
    expect(isCertificateErrorCode(-199)).toBe(false)
    expect(isCertificateErrorCode(-218)).toBe(false)
    expect(isCertificateErrorCode(-3)).toBe(false)
    expect(isCertificateErrorCode(0)).toBe(false)
    expect(isCertificateErrorCode(null)).toBe(false)
    expect(isCertificateErrorCode(undefined)).toBe(false)
  })
})

describe('matchesTabQuery(总览搜索)', () => {
  test('空查询全保留;大小写不敏感子串命中任一字段', () => {
    expect(matchesTabQuery('', [null, ''])).toBe(true)
    expect(matchesTabQuery('git', ['GitHub / lume'])).toBe(true)
    expect(matchesTabQuery('LUME', ['github.com/lume'])).toBe(true)
    expect(matchesTabQuery('zzz', ['github.com/lume', null])).toBe(false)
  })
})
