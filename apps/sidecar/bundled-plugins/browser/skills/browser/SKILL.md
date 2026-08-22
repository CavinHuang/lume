---
name: browser
description: Control pages in Lume's shared persistent in-app browser profile through built-in browser tools
activate-tools:
  - mcp__node_repl__js
---

# Lume Browser

Use this skill for ordinary live web navigation and interaction. The Browser runtime is built into Lume and defaults to the shared persistent `iab` profile, so logins and site storage survive Lume restarts while tab control remains scoped to the current task. Use external Chrome only when the user explicitly requests Chrome or needs its current Chrome tabs, profile, or extensions.

Treat connection setup as internal. Do not mention Browser Broker or runtime plumbing in user-facing updates unless the user asks about the implementation.

## Primary control loop: observe → act → observe

The `mcp__browser__*` tools are available for the whole user request. Never write browser JavaScript for ordinary interaction.

1. Start with `mcp__browser__list_tabs` to reuse the task's locked tab, or `mcp__browser__open` (url) when no suitable tab exists.
2. Call `mcp__browser__snapshot` before interacting. Interactive nodes carry refs such as `[ref=e12]`.
3. Act by ref: `mcp__browser__click` / `double_click` / `hover` / `fill` / `type` / `press` / `select` / `check` / `scroll` with `ref: "@e12"`.
4. Every mutation tool returns a fresh interactive snapshot of the post-action page. Read it before the next action, and use only refs from the newest snapshot.

Large or dense pages: follow the snapshot's `next_cursor` by passing it as the `cursor` argument until the tree is exhausted; drill into one subtree with `scope_ref`; request `interactive_only: true` first when you only need actionable controls. `mcp__browser__screenshot` with `annotated: true` labels visible elements with the same refs for visual inspection — screenshots are never interaction targets.

## Tab semantics

The session locks one active tab. `open` creates a new Agent-owned tab and locks it; `switch_tab` is the only way to move between Agent-owned tabs. A click that opens a new tab does not switch the lock — call `list_tabs`, then `switch_tab`. Navigation on the locked tab uses `navigate` / `back` / `forward` / `reload`.

## Dialogs, files, and credentials

- A blocking JavaScript dialog makes other actions return `dialog_blocking`. Read it with `mcp__browser__dialog`, then resolve it with `mcp__browser__handle_dialog`.
- Downloads: `mcp__browser__download` clicks a download control and waits for the file; when it returns `in_progress`, re-call with only `download_id` to poll. Completed files come back as task-scoped `file_ref` values you can pass to upload or read tools.
- Uploads: `mcp__browser__upload` takes a ref plus task-authorized file paths or browser-download `file_ref` values, and coordinates the file chooser itself.
- Credentials: call `mcp__browser__list_secrets` for the current origin, then `mcp__browser__fill_secret` with the returned `secret_id`. Never type passwords, OTPs, or tokens into `fill`/`type`.

## Failure and takeover handling

On `stale_target`, take a new snapshot and retry with the fresh refs. On `user_action_required` (MFA, CAPTCHA, hardware keys, payment), stop and ask the user to complete the step; do not retry it. On `user_takeover_required` or `paused_by_user`, the user has taken the page — stop all browser actions, say so, and wait until the user explicitly returns control. When a tool returns `repeated_action_failure`, do not retry the same action; report what blocked it.

## Diagnostics fallback

Only when the `mcp__browser__*` tools are unavailable or a tool insists the runtime is broken, fall back to the Node REPL client: load this Skill, then in the first `mcp__node_repl__js` call bootstrap with `${PLUGIN_DIR}/scripts/browser-client.mjs` (`setupLumeBrowserRuntime`), resume via `browser.tabs.resumeHandoff()`, set `timeout_ms` to `300000`, and return observations with `nodeRepl.write(JSON.stringify(value))`. Treat this as a diagnostic entry point, not the default control path.

Never claim Lume has no browser before attempting the built-in tools, and do not fall back to shell-driven UI automation or tool search for a replacement browser.
