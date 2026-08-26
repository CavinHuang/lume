#!/bin/bash
LOG=/tmp/wt-cleanup.log
: > "$LOG"
ROOT="D:/workspace/projects/ai-projects/lume"
W="$ROOT/.claude/worktrees"

remove_one() {
  local name="$1" path="$2" branch="$3" mode="$4"
  echo "=== $name ($branch) [$mode]" >> "$LOG"
  if [ "$mode" = "stash-first" ]; then
    git -C "$path" stash push --include-untracked -m "cleanup-residue $name $(date +%F)" >> "$LOG" 2>&1
  fi
  if [ "$mode" = "unlock" ]; then
    git worktree unlock "$path" >> "$LOG" 2>&1
  fi
  if git worktree remove "$path" >> "$LOG" 2>&1; then
    echo "  removed" >> "$LOG"
  elif git worktree remove --force "$path" >> "$LOG" 2>&1; then
    echo "  removed(force)" >> "$LOG"
  else
    echo "  REMOVE-FAILED" >> "$LOG"; return 1
  fi
  if git branch -D "$branch" >> "$LOG" 2>&1; then
    echo "  branch deleted" >> "$LOG"
  else
    echo "  branch-delete-failed" >> "$LOG"
  fi
}

# MERGED 且干净
for spec in \
  "browser-settings-gate|$W/browser-settings-gate|fix/browser-isenabled-settings-gate" \
  "browser-user-declined|$W/browser-user-declined|fix/browser-user-declined" \
  "wt-561-thinking|$W/wt-561-thinking|fix/561-provider-thinking-budgets" \
  "wt-563-project-instructions|$W/wt-563-project-instructions|fix/563-project-instructions-loading" \
  "wt-568-end-turn|$W/wt-568-end-turn|fix/568-end-turn-tool-use" \
  "wt-569-edit-guard|$W/wt-569-edit-guard|fix/569-edit-protection" \
  "wt-653-hardening|$W/wt-653-hardening|fix/653-instructions-hardening" \
  "wt-655-cache-hardening|$W/wt-655-cache-hardening|fix/655-cache-accounting" \
  "wt-issue567-compaction|$W/wt-issue567-compaction|feat/issue567-compaction" \
  "wt-issue571-perms|$W/wt-issue571-perms|feat/issue571-permission-friction" \
  "wt-issue572-revert|$W/wt-issue572-revert|feat/issue572-revert-entry" \
  "wt-test-pins|$W/wt-test-pins|fix/test-pins-fingerprint-rollout" \
; do
  IFS='|' read -r n p b <<< "$spec"
  remove_one "$n" "$p" "$b" "plain"
done

# 特殊况
remove_one "fix-followup-ledger" "$W/fix-followup-ledger" "fix/followup-ledger" "unlock"
remove_one "wt-571-ps-verbs" "$W/wt-571-ps-verbs" "fix/571-ps-dangerous-verbs" "force-tmp"
remove_one "issue-389-x9k" "$W/issue-389-x9k" "chore/389-sdk-simplify-batch-x9k" "stash-first"
remove_one "lume-gmail-wt" "$ROOT/lume-gmail-wt" "feat/gmail-connectors" "plain"
remove_one "homepage-theme-fix" "$ROOT/lume-worktrees/codex-homepage-theme-fix" "codex/homepage-theme-fix" "plain"
remove_one "website-redesign" "$ROOT/lume-worktrees/website-redesign" "codex/website-redesign" "plain"

git worktree prune >> "$LOG" 2>&1
echo "ALL-DONE" >> "$LOG"
