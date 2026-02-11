# Task 08 - Web Search Provider Layer

## Goal
Add pluggable web search with Tavily as default provider.

## In Scope
- Define provider interface (`query`, `health`, `normalize`).
- Implement Tavily adapter.
- Add provider fallback/error handling behavior for Agent mode.

## Out of Scope
- Full browser automation.

## Deliverables
1. Search provider abstraction in Sidecar.
2. Tavily implementation and mapping to shared search result type.
3. Agent tool integration with citation metadata.

## Acceptance Criteria
1. Search calls return normalized result schema.
2. Provider outage produces recoverable tool error.
3. Search outputs are visible in agent task timeline.

## Dependencies
- `07-parallel-task-scheduler`.

## Completion Note
- Pending.

