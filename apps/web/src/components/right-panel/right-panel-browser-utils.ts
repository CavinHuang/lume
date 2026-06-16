export interface RightPanelLocalBrowserService {
  title: string
  url: string
}

const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/.*)?$/i

export function normalizeRightPanelBrowserUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
  if (LOCAL_HOST_RE.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}

export function getDefaultLocalBrowserServices(): readonly RightPanelLocalBrowserService[] {
  return [
    {
      title: 'Lume',
      url: 'http://localhost:3000',
    },
  ] as const
}
