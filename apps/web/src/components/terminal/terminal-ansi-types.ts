/** ANSI 颜色名 → Tailwind 类（固定调色板近似；主题化 ANSI 变量为后续跟进）。 */
export const ANSI_COLOR_CLASSES = {
  black: 'text-neutral-500',
  red: 'text-red-500',
  green: 'text-green-500',
  yellow: 'text-yellow-500',
  blue: 'text-blue-500',
  magenta: 'text-fuchsia-500',
  cyan: 'text-cyan-500',
  white: 'text-neutral-300',
  brightBlack: 'text-neutral-400',
  brightRed: 'text-red-400',
  brightGreen: 'text-green-400',
  brightYellow: 'text-yellow-400',
  brightBlue: 'text-blue-400',
  brightMagenta: 'text-fuchsia-400',
  brightCyan: 'text-cyan-400',
  brightWhite: 'text-neutral-100',
} as const

export type AnsiColorName = keyof typeof ANSI_COLOR_CLASSES | null
