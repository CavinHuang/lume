# Log Viewer Design

## Goal

Add a Settings log viewer that helps diagnose Lume runtime state from local log files, while improving log collection for app, agent, subagent, tool, MCP, and skill-loading paths.

## Scope

- Add a Settings navigation item named `应用日志`.
- Read logs from the existing Lume logs directory.
- List log files with size and modified time.
- Show selected log content with level filtering and text search.
- Refresh, open log directory, and export all logs.
- Record diagnostic logs as redacted summaries, not full tool/MCP/skill payloads.

## Logging Model

The existing sidecar logger remains the source of truth. New collection work should reuse `createLogger` and write into the existing log directory. Diagnostic entries must include enough context to identify the failing path: source/context, thread id, workspace id/slug, run id when available, tool or server name, status, elapsed time, and error message/stack when present.

Sensitive fields such as token, secret, password, api key, and authorization values are redacted. Large tool and MCP inputs/results are summarized and truncated.

## UI Model

The Settings tab mirrors the provided mockup: a compact header, actions on the right, file picker, level picker, search input, and a large scrollable monospace log viewer. Warnings and errors are highlighted by level. Empty, loading, and error states are explicit.

## Testing

Test sidecar logic for file listing, reading/filtering, export path creation, and redaction. Test settings metadata so the new tab stays wired into navigation. UI styling does not need full visual tests.
