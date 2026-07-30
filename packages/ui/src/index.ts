/**
 * @lume/ui - 共享 UI 组件和 Hooks
 */

export { CodeBlock } from './code-block/index'
export { MermaidBlock } from './mermaid-block/index'
export { useSmoothStream } from './hooks/index'
export {
  clearHighlightCache,
  highlightCode,
  highlightCodeSync,
  highlightToTokens,
  type HighlightOptions,
  type HighlightResult,
  type HighlightToken,
  type HighlightTokensResult,
  CODEX_DARK_THEME,
  CODEX_DARK_THEME_NAME,
  CODEX_LIGHT_THEME,
  CODEX_LIGHT_THEME_NAME,
  CODEX_THEMES,
  getCodeThemeName,
  getCodeThemeType,
  useCodeTheme,
  type CodeThemeName,
} from './highlight/index'
