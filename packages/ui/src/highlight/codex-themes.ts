import type { ThemeRegistration } from 'shiki'

export const CODEX_LIGHT_THEME_NAME = 'lume-codex-light'
export const CODEX_DARK_THEME_NAME = 'lume-codex-dark'

export const CODEX_LIGHT_THEME: ThemeRegistration = {
  name: CODEX_LIGHT_THEME_NAME,
  type: 'light',
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#383a42',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#a0a1a7', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'entity.name.tag'], settings: { foreground: '#a626a4' } },
    { scope: ['entity.name.tag', 'markup.deleted', 'invalid'], settings: { foreground: '#e45649' } },
    { scope: ['constant.language', 'support.constant', 'constant.character', 'constant.other'], settings: { foreground: '#0184bb' } },
    { scope: ['string', 'string.quoted', 'markup.inserted'], settings: { foreground: '#50a14f' } },
    { scope: ['support.function', 'support.class', 'entity.name.function', 'variable.language'], settings: { foreground: '#c18401' } },
    { scope: ['entity.other.attribute-name', 'variable', 'constant.numeric', 'support.type'], settings: { foreground: '#986801' } },
    { scope: ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'markup.heading', 'markup.link'], settings: { foreground: '#4078f2' } },
  ],
}

export const CODEX_DARK_THEME: ThemeRegistration = {
  name: CODEX_DARK_THEME_NAME,
  type: 'dark',
  colors: {
    'editor.background': '#0d0d0d',
    'editor.foreground': '#ffffff',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#ffffff80', fontStyle: 'italic' } },
    { scope: ['meta', 'punctuation.definition.tag'], settings: { foreground: '#ffffff99' } },
    { scope: ['support.function', 'support.class', 'entity.name.class'], settings: { foreground: '#e9950c' } },
    { scope: ['keyword', 'comment.block.documentation', 'markup.inline.raw', 'constant.language'], settings: { foreground: '#2e95d3' } },
    { scope: ['string', 'string.regexp', 'markup.inserted', 'entity.other.attribute-name', 'meta.string'], settings: { foreground: '#00a67d' } },
    { scope: ['variable', 'support.type', 'constant.numeric', 'storage.type'], settings: { foreground: '#df3079' } },
    { scope: ['constant.other.symbol', 'markup.list', 'markup.link', 'markup.heading', 'entity.name.function'], settings: { foreground: '#f22c3d' } },
  ],
}

export const CODEX_THEMES = [CODEX_LIGHT_THEME, CODEX_DARK_THEME] as const

