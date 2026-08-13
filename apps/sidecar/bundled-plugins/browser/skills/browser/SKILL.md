---
name: browser
description: Control task-isolated pages in the Lume in-app browser
---

# Lume Browser

Use this skill for ordinary live web navigation and interaction. The Browser runtime is built into Lume and defaults to the task-isolated `iab` backend. Use external Chrome only when the user explicitly requests Chrome or needs its current tabs, profile, extensions, or login state.

Treat connection setup as internal. Do not mention Node REPL, JavaScript sessions, module imports, or Browser Broker in user-facing updates unless the user asks about the implementation.

Before the first browser action in a task, bootstrap the trusted client through `mcp__node_repl__js`:

```js
if (!globalThis.agent?.browsers) {
  var { setupLumeBrowserRuntime } = await import("${PLUGIN_DIR}/scripts/browser-client.mjs");
  await setupLumeBrowserRuntime({ globals: globalThis });
}
```

The runtime is persistent. Use `var` for reusable top-level bindings, and return observations with `nodeRepl.write(JSON.stringify(value))`; bare final expressions are invisible.

Select the in-app browser, create a tab, and navigate:

```js
var browser = await agent.browsers.getDefault();
var tab = await browser.tabs.new();
await tab.goto("https://example.com");
nodeRepl.write(JSON.stringify({ title: await tab.title(), url: await tab.url() }));
```

Prefer semantic Playwright locators and re-observe after navigation or a failed action:

```js
var snapshot = await tab.playwright.domSnapshot();
nodeRepl.write(JSON.stringify(snapshot));
var search = tab.playwright.getByRole("textbox", { name: "Search" });
await search.fill("Lume");
await search.press("Enter");
```

Read `await browser.documentation()` once before interaction and `await agent.documentation.get("confirmations")` before consequential actions. If setup fails, retry once; only then report the exact stable error. Never claim Lume has no browser before attempting this runtime, and do not fall back to shell-driven UI automation.
