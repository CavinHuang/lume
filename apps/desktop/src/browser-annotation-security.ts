export const BROWSER_ANNOTATION_POPUP_COMMANDS = ['add', 'send', 'cancel', 'delete', 'resize'] as const
export type BrowserAnnotationPopupCommand = typeof BROWSER_ANNOTATION_POPUP_COMMANDS[number]

export function isBrowserAnnotationPopupCommand(value: unknown): value is BrowserAnnotationPopupCommand {
  return typeof value === 'string' && (BROWSER_ANNOTATION_POPUP_COMMANDS as readonly string[]).includes(value)
}

export function isSafeBrowserAnnotationThreadId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,200}$/.test(value)
}
