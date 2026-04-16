interface Props { input?: Record<string, unknown>; result: unknown }

export function GlobResult({ result }: Props) {
  const files: string[] = (result as any)?.files ?? (result as any)?.paths ?? []
  return (
    <div className="bg-muted/30 rounded-lg p-3 font-mono text-[12px] space-y-0.5 max-h-60 overflow-y-auto">
      {files.map((f, i) => (
        <div key={i} className="text-foreground/70">{f}</div>
      ))}
    </div>
  )
}
