---
name: browser
description: Control pages in Lume's shared persistent in-app browser profile
activate-tools:
  - mcp__node_repl__js
---

# Lume Browser

Use this skill for ordinary live web navigation and interaction. The Browser runtime is built into Lume and defaults to the shared persistent `iab` profile, so logins and site storage survive Lume restarts while tab control remains scoped to the current task. Use external Chrome only when the user explicitly requests Chrome or needs its current Chrome tabs, profile, or extensions.

Treat connection setup as internal. Do not mention Node REPL, JavaScript sessions, module imports, or Browser Broker in user-facing updates unless the user asks about the implementation.

Before the first browser action in a task, bootstrap the trusted client through `mcp__node_repl__js`:

```js
if (!globalThis.agent?.browsers) {
  var { setupLumeBrowserRuntime } = await import("${PLUGIN_DIR}/scripts/browser-client.mjs");
  await setupLumeBrowserRuntime({ globals: globalThis });
}
```

Set `timeout_ms` to `300000` on browser `mcp__node_repl__js` calls. Navigation can wait for an action-time confirmation, so the default tool timeout is too short.
Set `title` to a short user-facing description such as `读取 X 首页` or `打开 GitHub Issue`; never expose the runtime implementation in that title.

The runtime is persistent. Use `var` for reusable top-level bindings, and return observations with `nodeRepl.write(JSON.stringify(value))`; bare final expressions are invisible.

Select the in-app browser and resume the task's existing tab before creating one:

```js
var browser = await agent.browsers.getDefault();
var resumedTabs = await browser.tabs.resumeHandoff();
var tab = resumedTabs[0]
  ?? await browser.tabs.selected();
if (!tab) tab = await browser.tabs.new();
if ((await tab.url()) !== "https://example.com") await tab.goto("https://example.com");
nodeRepl.write(JSON.stringify({ title: await tab.title(), url: await tab.url() }));
```

Only use `await browser.tabs.new({ sessionKind: "agent-task" })` when the user explicitly asks for an isolated or temporary session. That session intentionally does not retain login state after Lume exits.

For follow-up requests such as "continue", "read the latest posts", "click the third item", or "scroll down", keep using the resumed tab. Do not create a duplicate merely because the new turn has a new browser turn id. If an old binding returns `action_denied` or `tab_not_found`, discard it, call `browser.tabs.resumeHandoff()` once, select the visible result, and retry the observation.

Prefer semantic Playwright locators and re-observe after navigation or a failed action:

```js
var snapshot = await tab.playwright.domSnapshot();
nodeRepl.write(JSON.stringify(snapshot));
var search = tab.playwright.getByRole("textbox", { name: "Search" });
await search.fill("Lume");
await search.press("Enter");
```

For reading, prefer bounded visible text over dumping a full raw DOM snapshot:

```js
var text = await tab.playwright.locator("body").innerText();
nodeRepl.write(JSON.stringify({ url: await tab.url(), title: await tab.title(), text: text.slice(0, 20000) }));
```

For virtualized feeds or result lists, collect and deduplicate semantic items over a bounded number of scrolls. Start with `article`, `main article`, or another role/label derived from the live page; do not assume one selector works on every site:

```js
var seen = new Set();
var items = [];
for (var round = 0; round < 8 && items.length < 10; round += 1) {
  var visibleItems = await tab.playwright.locator("article").allTextContents();
  for (var itemText of visibleItems) {
    var normalized = itemText.trim();
    if (normalized && !seen.has(normalized)) { seen.add(normalized); items.push(normalized); }
  }
  if (items.length < 10) {
    await tab.cua.scroll({ scrollX: 0, scrollY: 800 });
    await tab.playwright.waitForTimeout(500);
  }
}
nodeRepl.write(JSON.stringify({ collected: items.length, items: items.slice(0, 10) }));
```

Keep observations compact. Return counts and the requested items, not entire page trees. Re-observe after every navigation and after each scroll batch before claiming that an item was found or an action succeeded.

Read `await browser.documentation()` once before interaction and `await agent.documentation.get("confirmations")` before consequential actions. If setup or resumption fails, refresh the runtime and retry once; only then report the exact stable error. Never claim Lume has no browser before attempting this runtime, and do not fall back to shell-driven UI automation or tool search for a replacement browser.
