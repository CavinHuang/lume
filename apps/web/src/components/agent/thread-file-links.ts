export function normalizeThreadFilePathCandidate(value: string): string | null {
  const path = value.trim().replace(/\\/g, '/')
  if (!path || path.length > 512) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  if (path.startsWith('/') || path.startsWith('~')) return null
  if (path.includes('\0') || /[\r\n\t]/.test(path)) return null

  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  if (!/\.[A-Za-z0-9]{1,12}$/.test(segments.at(-1) ?? '')) return null

  return segments.join('/')
}
