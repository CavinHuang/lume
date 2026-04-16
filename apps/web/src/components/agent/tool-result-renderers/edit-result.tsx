interface Props { input: Record<string, unknown>; result: unknown }

export function EditResult({ input, result }: Props) {
  const filePath = String(input.file_path ?? '')
  const oldStr = String(input.old_string ?? '')
  const newStr = String(input.new_string ?? '')

  // 如果后端返回了 patch，直接用 patch
  const patch = (result as Record<string, unknown>)?.patch as string | undefined

  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      <div className="px-3 py-1.5 text-[11px] text-foreground/50 bg-muted/40 font-mono truncate">
        {filePath}
      </div>
      {patch ? (
        <DiffView lines={patch.split('\n')} />
      ) : (
        <div className="divide-y divide-border/30">
          {oldStr && (
            <div className="bg-red-500/5">
              <div className="px-3 py-1 text-[10px] font-medium text-red-500/60">删除</div>
              <pre className="px-3 pb-2 text-[12px] font-mono leading-relaxed text-red-600 dark:text-red-400 whitespace-pre-wrap">{oldStr}</pre>
            </div>
          )}
          {newStr && (
            <div className="bg-green-500/5">
              <div className="px-3 py-1 text-[10px] font-medium text-green-500/60">添加</div>
              <pre className="px-3 pb-2 text-[12px] font-mono leading-relaxed text-green-600 dark:text-green-400 whitespace-pre-wrap">{newStr}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DiffView({ lines }: { lines: string[] }) {
  return (
    <pre className="p-3 text-[12px] font-mono leading-relaxed overflow-x-auto" style={{ backgroundColor: '#24292e' }}>
      {lines.map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+') ? 'text-green-400 bg-green-500/10' :
            line.startsWith('-') ? 'text-red-400 bg-red-500/10' :
            line.startsWith('@@') ? 'text-blue-400' :
            'text-zinc-400'
          }
        >{line}</div>
      ))}
    </pre>
  )
}
