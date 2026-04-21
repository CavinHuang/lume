import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getGitHubSkillReview, installGitHubSkillToWorkspace } from '@/lib/desktop-api'
import type { GitHubSkillReviewResult } from '@lume/shared'

export function GitHubInstallSheet({
  open,
  onOpenChange,
  workspaceSlug,
  onInstalled,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  workspaceSlug: string
  onInstalled: () => void
}) {
  const [url, setUrl] = React.useState('')
  const [review, setReview] = React.useState<GitHubSkillReviewResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      setUrl('')
      setReview(null)
      setError(null)
      setLoading(false)
    }
  }, [open])

  const handleReview = async () => {
    setLoading(true)
    setError(null)
    try {
      setReview(await getGitHubSkillReview({ url }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const handleInstall = async () => {
    if (!review) return
    setLoading(true)
    setError(null)
    try {
      await installGitHubSkillToWorkspace({
        url: review.url,
        workspaceSlug,
        reviewToken: review.reviewToken,
      })
      onInstalled()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0" showCloseButton>
        <DialogHeader className="p-5 pb-0">
          <DialogTitle>Install from GitHub</DialogTitle>
          <DialogDescription>
            Paste a public GitHub repository or tree URL. Lume will inspect it before installing anything.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 p-5">
          <div className="space-y-2">
            <label className="text-[12px] font-medium text-foreground">Repository URL</label>
            <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/acme/agent-skills" />
          </div>

          {error && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-[12px] text-destructive">
              {error}
            </div>
          )}

          {review && (
            <div className="space-y-3 rounded-2xl border bg-muted/30 p-4 text-[12px]">
              <div>
                <div className="font-medium">{review.owner}/{review.repo}</div>
                <div className="mt-1 text-muted-foreground">
                  ref: {review.ref} {review.rootPath ? `· path: ${review.rootPath}` : ''}
                </div>
              </div>

              <div>
                <div className="font-medium">Detected skills</div>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                  {review.skills.map((item) => (
                    <li key={item.slug}>
                      {item.name} ({item.slug})
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="font-medium">Risk summary</div>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                  {review.riskSummary.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              {review.structuralIssues.length > 0 && (
                <div>
                  <div className="font-medium">Structural issues</div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                    {review.structuralIssues.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {review ? (
            <Button onClick={() => void handleInstall()} disabled={loading}>
              {loading && <Loader2 size={14} className="animate-spin" />}
              Install to Workspace
            </Button>
          ) : (
            <Button onClick={() => void handleReview()} disabled={loading || !url.trim()}>
              {loading && <Loader2 size={14} className="animate-spin" />}
              Review Repository
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
