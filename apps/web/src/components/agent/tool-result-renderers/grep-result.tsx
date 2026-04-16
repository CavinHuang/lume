interface Props { input?: Record<string, unknown>; result: unknown }

export function GrepResult({ result }: Props) {
  const output = String((result as any)?.output ?? result ?? '')
  const lines = output.split('\n').filter(Boolean)
  return (
    <div className="bg-muted/30 rounded-lg p-3 font-mono text-[12px] space-y-0.5 max-h-60 overflow-y-auto">
      {lines.map((line, i) => (
        <div key={i} className="text-foreground/70 leading-relaxed">{line}</div>
      ))}
    </div>
  )
}
