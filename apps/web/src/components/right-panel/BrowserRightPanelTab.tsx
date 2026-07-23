import { BrowserShell } from '@/components/browser/BrowserShell'
import type { BrowserTabState } from './right-panel-state'

export function BrowserRightPanelTab({ state, onChange }: { state: BrowserTabState; onChange: (next: BrowserTabState) => void }) {
  return (
    <BrowserShell
      tabId="right-panel-browser"
      initialUrl={state.url}
      surface="right-panel"
      onUrlChange={(url) => onChange({ ...state, url, addressInput: url })}
    />
  )
}
