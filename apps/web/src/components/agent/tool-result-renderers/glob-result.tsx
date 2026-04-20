interface Props { input?: Record<string, unknown>; result: unknown }

function normalizeMatches(result: unknown): string[] {
  const payload = result as {
    files?: unknown
    paths?: unknown
    matches?: unknown
    data?: {
      files?: unknown
      paths?: unknown
      matches?: unknown
    }
  } | undefined

  const candidates = [
    result,
    payload?.files,
    payload?.paths,
    payload?.matches,
    payload?.data?.files,
    payload?.data?.paths,
    payload?.data?.matches,
  ]

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map((entry) => String(entry))
    }
  }

  return []
}

export function GlobResult({ input, result }: Props) {
  const files = normalizeMatches(result)
  const pattern = typeof input?.pattern === 'string' ? input.pattern : ''
  const path = typeof input?.path === 'string' ? input.path : ''

  return (
    <div className="bg-muted/30 rounded-lg p-3 font-mono text-[12px] space-y-0.5 max-h-60 overflow-y-auto">
      {(pattern || path) && (
        <div className="mb-2 space-y-1 border-b border-border/30 pb-2 text-[11px] text-foreground/50">
          {pattern && <div>pattern: {pattern}</div>}
          {path && <div>path: {path}</div>}
        </div>
      )}
      {files.map((f, i) => (
        <div key={i} className="text-foreground/70">{f}</div>
      ))}
    </div>
  )
}
