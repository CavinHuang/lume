# Definition of Done (DoD)

A task/PR is considered "done" only when all checks below pass.

## Required

- [ ] PR created
- [ ] Branch synced to `master` (no merge conflicts)
- [ ] CI passing
  - [ ] `bun run typecheck`
  - [ ] `bun run build`
- [ ] Reviews
  - [ ] Codex review passed
  - [ ] Claude Code review passed

## If UI changes

- [ ] Screenshot included in PR description (or attached as artifact)

## Hygiene

- [ ] Clear scope summary in PR description
- [ ] Any new behavior has at least minimal coverage (tests or deterministic reproduction steps)
