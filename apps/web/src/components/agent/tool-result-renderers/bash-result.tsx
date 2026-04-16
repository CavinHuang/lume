import { HighlightedCode } from './highlighted-code'
import { CollapsibleResult } from './collapsible-result'

interface Props { input: Record<string, unknown>; result: unknown }

export function BashResult({ input, result }: Props) {
  const output = (result as Record<string, unknown>)?.output ?? (result as Record<string, unknown>)?.stdout ?? String(result ?? '')
  const stderr = (result as Record<string, unknown>)?.stderr as string | undefined
  const command = String(input.command ?? '')

  return (
    <div className="space-y-2">
      <div className="bg-zinc-950 rounded-lg px-3 py-1.5 font-mono text-[11px] text-zinc-500">
        $ {command}
      </div>
      {output && (
        <CollapsibleResult
          content={String(output)}
          previewLines={20}
          renderContent={(text) => (
            <HighlightedCode code={text} language="shellscript" />
          )}
        />
      )}
      {stderr && (
        <div className="rounded-lg border border-red-500/20 overflow-hidden">
          <div className="px-3 py-1 bg-red-500/10 text-[11px] text-red-400 font-medium">stderr</div>
          <pre className="p-3 text-[12px] font-mono leading-relaxed text-red-400 bg-zinc-950 whitespace-pre-wrap break-all">{stderr}</pre>
        </div>
      )}
    </div>
  )
}
