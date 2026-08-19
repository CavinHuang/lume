import { Sparkles } from 'lucide-react'
import type { MemorySettingsSnapshot, SuggestionFeedback, SuggestionRecord } from '@lume/shared'
import { PersonaCard } from './MemoryLibraryView'
import { MemoryEmptyState, MemorySection, SuggestionRow } from './MemoryAttentionView'

export function MemoryInsightsView({
  workspaceSlug,
  snapshot,
  suggestions,
  busySuggestionId,
  onActSuggestion,
  onDeleteSuggestion,
}: {
  workspaceSlug: string
  snapshot: MemorySettingsSnapshot | null
  suggestions: SuggestionRecord[]
  busySuggestionId: number | null
  onActSuggestion: (id: number, feedback: SuggestionFeedback) => void
  onDeleteSuggestion: (id: number) => void
}) {
  return (
    <div className="space-y-4">
      <PersonaCard workspaceSlug={workspaceSlug} />
      {snapshot?.workspaceBrief && (
        <section className="lume-panel animate-in fade-in slide-in-from-bottom-1 p-4 duration-300 motion-reduce:animate-none">
          <h2 className="text-sm font-semibold">当前工作区洞察</h2>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
            {snapshot.workspaceBrief.markdown}
          </pre>
        </section>
      )}
      <MemorySection title="工作模式建议" icon={<Sparkles size={15} />}>
        {suggestions.length === 0 ? (
          <MemoryEmptyState text="暂无待定建议" />
        ) : (
          <div className="space-y-2">
            {suggestions.map((record, index) => (
              <div
                key={record.id}
                className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300 motion-reduce:animate-none"
                style={{ animationDelay: `${index * 80}ms` }}
              >
                <SuggestionRow
                  record={record}
                  busy={busySuggestionId === record.id}
                  onAct={(feedback) => onActSuggestion(record.id, feedback)}
                  onDelete={() => onDeleteSuggestion(record.id)}
                />
              </div>
            ))}
          </div>
        )}
      </MemorySection>
    </div>
  )
}
