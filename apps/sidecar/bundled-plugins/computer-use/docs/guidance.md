# Computer Use Guidance

Start with `list_apps()`, select one unique application window, refresh it with `get_window({ id, app })`, and then observe it with `get_window_state`.

Passive observation does not foreground the application. Input methods restore and activate their target window atomically. Call `activate_window` only when foregrounding is itself required.

`get_window_state` includes screenshots by default. Request `{ include_screenshot: false, include_text: true }` when accessibility text or element indices are needed without an image. Always replace a cached Window with `state.window` after observing.

Prefer an `element_index` action when the accessibility snapshot exposes the intended control. Otherwise use coordinates relative to the most recent screenshot and pass its `screenshotId`.

Run stable actions sequentially in one JavaScript cell. Observe again only when focus may have changed, a modal may have appeared, progress must be evaluated, or the final result must be verified. A null input result means the action was dispatched, not that its business outcome was verified.

If a window is minimized, activate it, reacquire it with `get_window`, and observe again. If a window or element is stale, return to application discovery instead of guessing identifiers.

Never switch to shell-driven desktop automation when Computer Use fails. Stop after one reconnect attempt and explain the concrete connection or permission error.
