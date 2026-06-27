interface Props { input: Record<string, unknown>; result: unknown }

interface RenderedTodo { content: string; status?: string }

export function TodoResult({ result }: Props) {
  const raw = String(result ?? '')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0 && l !== 'No active todos.')
  // 只认 [x]/[~]/[ ] 开头的行；忽略其它（如 verificationNudge 文本）
  const todos: RenderedTodo[] = lines.flatMap((line) => {
    const m = line.match(/^\[(x|~| )\]\s+(.*)$/)
    if (!m) return []
    const marker = m[1]!
    const status = marker === 'x' ? 'completed' : marker === '~' ? 'in_progress' : 'pending'
    return [{ content: m[2]!, status }]
  })

  if (todos.length === 0) {
    return <div className="px-3 py-2 text-[12px] text-foreground/50">无活跃任务</div>
  }

  return (
    <div className="space-y-0.5 px-1 py-1">
      {todos.map((t, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px]">
          <span className="font-mono text-foreground/40 w-4">
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◉' : '○'}
          </span>
          <span className={t.status === 'completed' ? 'text-foreground/40 line-through' : 'text-foreground/70'}>
            {t.content}
          </span>
        </div>
      ))}
    </div>
  )
}
