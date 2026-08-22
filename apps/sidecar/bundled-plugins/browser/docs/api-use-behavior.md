# API use behavior

Control pages through the built-in `mcp__browser__*` tools: `list_tabs`/`open`/`switch_tab` for tabs, `snapshot` for observation, and ref-based actions such as `click`, `fill`, `select`, and `press`. Prefer refs from the latest snapshot over coordinates or CSS selectors. `mcp__node_repl__js` with `browser-client.mjs` remains a diagnostics entry point when the built-in tools are unavailable.

Keep observations compact. Report counts and the requested items, not entire page trees, and re-observe after every navigation before claiming an action succeeded.
