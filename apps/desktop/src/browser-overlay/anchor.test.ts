import { test, expect } from 'bun:test'
import { domPath, selectorFor, buildAnchor, locateAnchor, rectOf, cssEscape } from './anchor'

test('domPath 生成 tag > nth-of-type 路径', () => {
  document.body.innerHTML = '<div><span></span><span></span></div>'
  const span = document.body.querySelector('span:last-child')!
  expect(domPath(span)).toBe('html > body > div > span:nth-of-type(2)')
})

test('selectorFor 优先 #id', () => {
  document.body.innerHTML = '<div id="x"></div>'
  expect(selectorFor(document.getElementById('x')!)).toBe('#x')
})

test('selectorFor 用 data-testid', () => {
  document.body.innerHTML = '<button data-testid="save"></button>'
  expect(selectorFor(document.querySelector('button')!)).toBe('[data-testid="save"]')
})

test('cssEscape 转义特殊字符', () => {
  expect(cssEscape('a.b')).toBe('a\\.b')
})

test('locateAnchor 用 selector 找回元素', () => {
  document.body.innerHTML = '<button id="save">Save</button>'
  const win = window as unknown as { location: { href: string } }
  win.location.href = location.href
  const anchor = { kind: 'element' as const, url: location.href, generation: 1, framePath: [], rect: { x: 0, y: 0, width: 10, height: 10 }, selector: '#save' }
  const located = locateAnchor(anchor as never, document, window)
  expect(located?.status).toBe('attached')
  expect(located?.target).toBe(document.getElementById('save'))
})

test('locateAnchor 无匹配回退 degraded rect', () => {
  const anchor = { kind: 'element', url: location.href, generation: 1, framePath: [], rect: { x: 5, y: 5, width: 10, height: 10 } }
  const located = locateAnchor(anchor as never, document, window)
  expect(located?.status).toBe('degraded')
})
