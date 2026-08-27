#!/usr/bin/env bash
# PR#668 合并风暴自动追赶：merge main/head → 回归 → push → 轮询 CLEAN → squash
cd /d/workspace/projects/ai-projects/lume/.claude/worktrees/pr668-merge || exit 9
ok=0
for round in 1 2 3 4 5 6 7 8; do
  git fetch origin main fix/624-process-resilience >/dev/null 2>&1
  behind_main=$(git rev-list --count HEAD..origin/main)
  behind_head=$(git rev-list --count HEAD..origin/fix/624-process-resilience)
  echo "== round$round behind(main=$behind_main head=$behind_head)"
  if [ "$behind_main" -gt 0 ] || [ "$behind_head" -gt 0 ]; then
    git merge origin/main --no-edit >/dev/null 2>&1 || { echo "CONFLICT-MAIN"; break; }
    git merge origin/fix/624-process-resilience --no-edit >/dev/null 2>&1 || { echo "CONFLICT-HEAD"; break; }
    bun run --filter @lume/sidecar typecheck >/dev/null 2>&1 || { echo "TYPECHECK-FAIL"; break; }
    timeout 200 bun test apps/sidecar/src/services/agent-runtime/runtime-core/coding-change-service.test.ts apps/sidecar/src/services/automation/ >/dev/null 2>&1 || { echo "TEST-FAIL"; break; }
    git push origin pr668-merge-staging:fix/624-process-resilience >/dev/null 2>&1 || { echo "PUSH-REJECT"; continue; }
    echo "pushed round$round"
  fi
  for i in $(seq 1 10); do
    st=$(gh pr view 668 --json mergeStateStatus --jq '.mergeStateStatus' 2>/dev/null)
    case "$st" in
      *CLEAN*|*HAS_HOOKS*)
        echo "== CLEAN at round$round, merging"
        gh pr merge 668 --squash --delete-branch=false 2>&1 | tail -2 && ok=1 && break 3 ;;
      BEHIND) break ;;
      UNKNOWN) sleep 40 ;;
      *) echo "== state=$st, waiting"; sleep 45 ;;
    esac
  done
  [ "$ok" = "1" ] && break
done
[ "$ok" = "1" ] && echo MERGED || echo NOT-MERGED
