export function isSafeBrowserAnnotationThreadId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,200}$/.test(value)
}
