/**
 * 语法高亮模块
 *
 * 基于 Shiki 的代码语法高亮服务，支持懒加载和按需加载语言。
 */

export {
  clearHighlightCache,
  highlightCode,
  highlightCodeSync,
  highlightToTokens,
  isHighlighterReady,
  type HighlightOptions,
  type HighlightResult,
  type HighlightToken,
  type HighlightTokensResult,
} from './shiki-service'
export {
  CODEX_DARK_THEME,
  CODEX_DARK_THEME_NAME,
  CODEX_LIGHT_THEME,
  CODEX_LIGHT_THEME_NAME,
  CODEX_THEMES,
} from './codex-themes'
export {
  getCodeThemeName,
  getCodeThemeType,
  useCodeTheme,
  type CodeThemeName,
} from './theme-runtime'
