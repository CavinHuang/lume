import {
  CODEX_DARK_THEME,
  CODEX_DARK_THEME_NAME,
  CODEX_LIGHT_THEME,
  CODEX_LIGHT_THEME_NAME,
} from '@lume/ui'
import { registerCustomTheme } from '@pierre/diffs'

let registered = false

export function registerLumeDiffThemes(): void {
  if (registered) return
  registered = true
  registerCustomTheme(CODEX_LIGHT_THEME_NAME, async () => CODEX_LIGHT_THEME as never)
  registerCustomTheme(CODEX_DARK_THEME_NAME, async () => CODEX_DARK_THEME as never)
}

export const LUME_DIFF_THEMES = {
  light: CODEX_LIGHT_THEME_NAME,
  dark: CODEX_DARK_THEME_NAME,
} as const

export const LUME_DIFF_CSS = `
  :host {
    --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
    --diffs-gap-inline: 8px;
    --codex-diffs-surface: var(--lume-bg-panel, var(--background));
    --codex-diffs-context-surface: color-mix(in srgb, var(--codex-diffs-surface) 94%, var(--lume-bg-app, var(--background)));
    --codex-diffs-separator-surface: color-mix(in srgb, var(--codex-diffs-surface) 94%, var(--lume-accent, var(--primary)));
    --codex-diffs-hover-surface: color-mix(in srgb, var(--codex-diffs-surface) 92%, var(--lume-bg-app, var(--background)));
    --diffs-bg: var(--codex-diffs-surface) !important;
    --diffs-bg-context-override: var(--codex-diffs-context-surface);
    --diffs-bg-separator-override: var(--codex-diffs-separator-surface);
    --diffs-bg-hover-override: var(--codex-diffs-hover-surface);
    background-color: var(--codex-diffs-surface) !important;
  }
  pre {
    margin: 0;
    font-family: var(--diffs-font-family);
    font-size: 12px;
    line-height: 20px;
    background: var(--codex-diffs-surface);
  }
  [data-code] {
    scrollbar-gutter: auto;
  }
  [data-line-type="change-addition"]:is([data-line], [data-no-newline]) {
    --diffs-computed-diff-line-bg: var(--diffs-bg-addition);
  }
  [data-line-type="change-deletion"]:is([data-line], [data-no-newline]) {
    --diffs-computed-diff-line-bg: var(--diffs-bg-deletion);
  }
  [data-line-type="change-addition"]:is([data-column-number], [data-gutter-buffer]) {
    --diffs-computed-diff-line-bg: color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-addition-base));
  }
  [data-line-type="change-deletion"]:is([data-column-number], [data-gutter-buffer]) {
    --diffs-computed-diff-line-bg: color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-deletion-base));
  }
  [data-selected-line][data-line-annotation] {
    background-color: var(--diffs-bg);
  }
  [data-separator="line-info"] [data-expand-button] {
    border-inline-end: 1px solid var(--diffs-bg);
    border-start-start-radius: 8px;
    border-end-start-radius: 8px;
  }
  [data-separator="line-info"] [data-separator-wrapper][data-separator-multi-button] [data-expand-up] {
    border-end-start-radius: 0;
  }
  [data-separator="line-info"] [data-separator-wrapper][data-separator-multi-button] [data-expand-down] {
    border-start-start-radius: 0;
  }
  [data-unified] [data-separator="line-info"] [data-separator-content] {
    border-start-end-radius: 8px;
    border-end-end-radius: 8px;
  }
  [data-unified] [data-separator="line-info"] [data-separator-wrapper] {
    grid-template-columns: var(--diffs-column-number-width) minmax(0, 1fr);
    padding-inline: 2px;
  }
  [data-split] [data-deletions] [data-gutter] [data-separator="line-info"] [data-separator-wrapper] {
    grid-template-columns: minmax(0, 1fr);
    padding-inline: 2px 0;
    border-start-start-radius: 8px;
    border-end-start-radius: 8px;
  }
  [data-split] [data-deletions] [data-gutter] [data-separator="line-info"] [data-separator-content],
  [data-split] [data-deletions] [data-content] [data-separator="line-info"] [data-expand-button] {
    display: none;
  }
  [data-split] [data-deletions] [data-content] [data-separator="line-info"] [data-separator-wrapper] {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    padding: 0;
  }
  [data-split] [data-deletions] [data-content] [data-separator="line-info"] [data-separator-content] {
    grid-column: 1;
  }
  [data-split] [data-additions] [data-gutter] [data-separator="line-info"],
  [data-split] [data-additions] [data-gutter] [data-separator="line-info"] [data-separator-wrapper] {
    background-color: var(--diffs-bg-separator);
  }
  [data-split] [data-additions] [data-gutter] [data-separator="line-info"] [data-separator-wrapper] {
    padding: 0;
    border-start-end-radius: 0;
    border-end-end-radius: 0;
  }
  [data-split] [data-additions] [data-content] [data-separator="line-info"] [data-separator-wrapper] {
    border-start-end-radius: 8px;
    border-end-end-radius: 8px;
  }
  [data-diffs-header] {
    border-color: var(--lume-border-subtle, var(--border));
    background: var(--lume-bg-rail, var(--muted));
  }
`
