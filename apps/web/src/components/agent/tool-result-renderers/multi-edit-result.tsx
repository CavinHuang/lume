import { EditResult } from './edit-result'

interface Props { input?: Record<string, unknown>; result: unknown }

/** MultiEdit 结果：复用 EditResult 的 diff 卡逐 hunk 展示，头部共享同一 file_path。 */
export function MultiEditResult({ input, result }: Props) {
  const edits = Array.isArray(input?.edits) ? input.edits : []
  if (edits.length === 0) {
    return <EditResult input={input ?? {}} result={result} />
  }
  return (
    <div className="space-y-2">
      {edits.map((edit, index) => {
        const hunk = (edit && typeof edit === 'object' ? edit : {}) as Record<string, unknown>
        return (
          <EditResult
            key={index}
            input={{
              file_path: input?.file_path,
              old_string: hunk.old_string,
              new_string: hunk.new_string,
            }}
            result={result}
          />
        )
      })}
    </div>
  )
}
