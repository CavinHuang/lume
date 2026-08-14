---
name: computer-use
description: Control desktop applications through Lume Computer Use
activate-tools:
  - mcp__node_repl__js
---

# Computer Use

Use this skill for native desktop applications. Browser pages should use the Browser or Chrome capability when it is available.

Treat connection setup as internal. Do not mention Node REPL, JavaScript sessions, module imports, or `sky` in user-facing updates unless the user asks about the implementation.

Before the first desktop action in a task, bootstrap the trusted client through `mcp__node_repl__js` using the absolute path of this plugin's `scripts/computer-use-client.mjs`:

```js
if (!globalThis.sky) {
  const { setupComputerUseRuntime } = await import("${PLUGIN_DIR}/scripts/computer-use-client.mjs");
  await setupComputerUseRuntime({ globals: globalThis });
}
```

Then read the runtime guidance, exact API, and confirmation policy once:

```js
globalThis.computerUseGuidance = await sky.documentation("guidance")
globalThis.computerUseApi = await sky.documentation("api")
globalThis.computerUseConfirmations = await sky.documentation("confirmations")
nodeRepl.write(`${computerUseGuidance}\n\n${computerUseApi}\n\n${computerUseConfirmations}`)
```

The Node tool only returns string values passed to `nodeRepl.write`. Bare final expressions are invisible; use `nodeRepl.write(JSON.stringify(value))` for structured output.

Use the exact snake_case Window2 methods from the API. Start discovery with `await sky.list_apps()`; do not translate method names to `listApplications`, `focusApplication`, or `observe`.

`list_apps()` returns application descriptors, not Windows. Select a Window from an application's `windows` array before calling `get_window`. Window is plain data and has no methods; every action is a `sky.*` call. `WindowState` uses `accessibility` and plural `screenshots`, never `text` or singular `screenshot`:

```js
globalThis.apps = await sky.list_apps()
// Replace this exact matcher with the application requested by the user.
globalThis.targetApp = apps.find(app => app.displayName === "微信" && app.windows.length === 1)
if (!targetApp || targetApp.windows.length !== 1) {
  nodeRepl.write(JSON.stringify({
    error: "Select one unique application window",
    candidates: apps.filter(app => /微信|wechat|weixin/i.test(`${app.displayName ?? ""} ${app.id}`))
  }))
} else {
  globalThis.targetWindow = targetApp.windows[0]
  targetWindow = await sky.get_window({ id: targetWindow.id, app: targetWindow.app })
  globalThis.state = await sky.get_window_state({ window: targetWindow })
  targetWindow = state.window
  globalThis.screenshot = state.screenshots[0]
}
```

For a coordinate action, call the client directly and pass the current Window and screenshot ID:

```js
await sky.click({ window: targetWindow, x, y, screenshotId: state.screenshots[0].id })
await sky.type_text({ window: targetWindow, text })
state = await sky.get_window_state({ window: targetWindow })
targetWindow = state.window
```

Keep reusable top-level bindings such as `apps`, `targetWindow`, and `state`. After every observation, replace the old target with `targetWindow = state.window`. Never invent or reconstruct a window ID.

If the trusted client or desktop host is unavailable after one retry, stop and report the failure. Do not fall back to PowerShell SendKeys, WScript, pyautogui, ctypes, robotjs, terminal UI automation, or system-key shortcuts.
