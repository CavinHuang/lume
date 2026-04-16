interface Props { toolName?: string; input: Record<string, unknown>; result: unknown }

export function DefaultResult({ input, result }: Props) {
  const text = result === undefined ? JSON.stringify(input, null, 2) : JSON.stringify(result, null, 2)
  return (
    <pre className="bg-muted/30 rounded-lg p-3 text-[12px] font-mono text-foreground/70 overflow-x-auto whitespace-pre-wrap">
      {text}
    </pre>
  )
}
