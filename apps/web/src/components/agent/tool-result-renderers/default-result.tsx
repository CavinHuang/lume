interface Props { toolName?: string; input: Record<string, unknown>; result: unknown }

export function DefaultResult({ input, result }: Props) {
  // 字符串结果直接渲染（依赖 whitespace-pre-wrap 保留真实换行），
  // 不要 JSON.stringify —— 它会把真实换行转义成字面量 \n，导致界面显示 \n。
  const text = result === undefined
    ? JSON.stringify(input, null, 2)
    : typeof result === 'string'
      ? result
      : JSON.stringify(result, null, 2)
  return (
    <pre className="bg-muted/30 rounded-lg p-3 text-[12px] font-mono text-foreground/70 overflow-x-auto whitespace-pre-wrap">
      {text}
    </pre>
  )
}
