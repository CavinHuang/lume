// bun:test DOM environment for apps/desktop.
//
// Bun's `preload = ["happy-dom"]` does NOT auto-register globals with
// happy-dom 15.x (the package exports classes; no self-registering side
// effect). We instantiate a Window and assign the globals tests rely on.
// Only add globals that tests actually use; node-style test scripts in
// scripts/*.test.mjs are unaffected (they don't reference DOM globals).
import { Window } from 'happy-dom'

const dom = new Window()

const domGlobals: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  location: dom.location,
  navigator: dom.navigator,
  Node: dom.Node,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  NodeFilter: dom.NodeFilter,
  Range: dom.Range,
  TreeWalker: dom.TreeWalker,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  CSS: dom.CSS,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
}

for (const [key, value] of Object.entries(domGlobals)) {
  if (!(key in globalThis)) {
    ;(globalThis as Record<string, unknown>)[key] = value
  }
}
