import { describe, expect, test } from 'bun:test'
import { positionBrowserAnnotationPopup } from './browser-annotation-position'

const parent = { x: 100, y: 50, width: 1_400, height: 900 }
const surface = { x: 700, y: 100, width: 700, height: 800 }
const display = { x: 0, y: 0, width: 1_920, height: 1_080 }

describe('positionBrowserAnnotationPopup', () => {
  test('keeps a popup next to a marker inside the browser surface', () => {
    expect(positionBrowserAnnotationPopup({
      parent,
      surface,
      point: { x: 680, y: 200 },
      popup: { width: 340, height: 190 },
      viewport: { width: 700, height: 800 },
      display,
    })).toEqual({ x: 1_119, y: 196 })
  })

  test('accounts for a zoomed browser viewport', () => {
    expect(positionBrowserAnnotationPopup({
      parent,
      surface,
      point: { x: 300, y: 100 },
      popup: { width: 280, height: 140 },
      viewport: { width: 350, height: 400 },
      display,
    })).toEqual({ x: 1_108, y: 246 })
  })

  test('places the popup above when there is no room below', () => {
    expect(positionBrowserAnnotationPopup({
      parent,
      surface,
      point: { x: 100, y: 780 },
      popup: { width: 280, height: 190 },
      viewport: { width: 700, height: 800 },
      display,
    })).toEqual({ x: 912, y: 752 })
  })

  test('pins the popup to the browser edge after its anchor scrolls out of view', () => {
    const common = {
      parent,
      surface,
      popup: { width: 280, height: 190 },
      viewport: { width: 700, height: 800 },
      display,
    }

    expect(positionBrowserAnnotationPopup({ ...common, point: { x: 350, y: -400 } })).toEqual({ x: 858, y: 158 })
    expect(positionBrowserAnnotationPopup({ ...common, point: { x: 350, y: 1_200 } })).toEqual({ x: 858, y: 752 })
  })
})
