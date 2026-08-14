# API use behavior

Use `agent.browsers.getDefault()` for Lume's shared persistent in-app browser profile. Create or select a tab through `browser.tabs`, then prefer Playwright role, label, placeholder, text, test-id, or CSS locators over coordinates. Use `browser.tabs.new({ sessionKind: "agent-task" })` only for explicitly requested isolated browsing.

Keep reusable browser and tab bindings in the persistent runtime. Use `nodeRepl.write(JSON.stringify(value))` for observations because bare final expressions are not returned.
