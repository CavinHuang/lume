# API use behavior

Use `agent.browsers.getDefault()` for the task-isolated in-app browser. Create or select a tab through `browser.tabs`, then prefer Playwright role, label, placeholder, text, test-id, or CSS locators over coordinates.

Keep reusable browser and tab bindings in the persistent runtime. Use `nodeRepl.write(JSON.stringify(value))` for observations because bare final expressions are not returned.
