# Zoe (Agent Swarm) — One-Person Dev Team Ops

This folder bootstraps an agent-swarm workflow inspired by Elvis' OpenClaw + Codex/ClaudeCode setup.

Goal: keep business context + orchestration in "Zoe" (you/OpenClaw), while coding agents stay focused on code.

## Workflow (high level)

1. Pick a task → create a task file in `ops/zoe/tasks/`
2. Spawn one agent per task (each in its own git worktree + tmux session)
3. Agent implements, commits, pushes, opens a PR
4. DoD gate:
   - PR created
   - branch is conflict-free with `master`
   - CI passing (GitHub Actions)
   - reviews passed (Codex + Claude Code initially)
   - if UI changed: screenshot included in PR description
5. Monitor loop (cron) checks status via deterministic scripts + `gh`

## Files

- `dod.md` — Definition of Done gate checklist
- `tasks/` — task briefs (source of truth for what an agent should do)
- `scripts/` — helper scripts (kickoff/monitor/cleanup)

## Notes

- CI lives in `.github/workflows/ci.yml`.
- Start with concurrency=2 to avoid RAM/CPU contention.
