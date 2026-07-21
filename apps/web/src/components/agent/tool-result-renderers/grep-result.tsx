interface Props { input?: Record<string, unknown>; result: unknown }

export function formatGrepResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === null || result === undefined) return ''
  if (typeof result !== 'object') return String(result)

  const data = result as Record<string, unknown>
  const output = data.output ?? data.stdout
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(formatGrepValue).join('\n')
  if (Array.isArray(data.matches)) return data.matches.map(formatGrepValue).join('\n')
  return JSON.stringify(result, null, 2)
}

function formatGrepValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function GrepResult({ result }: Props) {
  const output = formatGrepResult(result)
  const lines = output.split('\n').filter(Boolean)
  return (
    <div className="bg-muted/30 rounded-lg p-3 font-mono text-[12px] space-y-0.5 max-h-60 overflow-y-auto">
      {lines.map((line, i) => (
        <div key={i} className="text-foreground/70 leading-relaxed">{line}</div>
      ))}
    </div>
  )
}
