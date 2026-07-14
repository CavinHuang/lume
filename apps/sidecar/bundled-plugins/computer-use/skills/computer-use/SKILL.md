---
name: computer-use
description: Control desktop applications through Lume Computer Use
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

Then read the runtime guidance and confirmation policy once:

```js
await sky.documentation("guidance")
await sky.documentation("confirmations")
```

Use `await sky.documentation("api")` when an exact method signature is needed.

Keep reusable top-level bindings such as `apps`, `targetWindow`, and `state`. After every observation, replace the old target with `targetWindow = state.window`. Never invent or reconstruct a window ID.

If the trusted client or desktop host is unavailable after one retry, stop and report the failure. Do not fall back to PowerShell SendKeys, WScript, pyautogui, ctypes, robotjs, terminal UI automation, or system-key shortcuts.
