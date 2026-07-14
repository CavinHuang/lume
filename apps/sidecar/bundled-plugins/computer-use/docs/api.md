# Sky Window2 API

`Window` is `{ app: string, id: number, title?: string }`. Reuse the object returned by the latest observation.

- `list_windows(): Promise<Window[]>`
- `get_window({ id, app? }): Promise<Window>`
- `list_apps(): Promise<Array<{ id, displayName?, isRunning?, windows }>>`
- `launch_app({ app }): Promise<null>`
- `get_window_state({ window, include_screenshot?, include_text? }): Promise<{ window, accessibility, screenshots }>`
- `click({ window, element_index } | { window, x, y, screenshotId?, click_count?, mouse_button? }): Promise<null>`
- `press_key({ window, key }): Promise<null>`
- `type_text({ window, text }): Promise<null>`
- `scroll({ window, x, y, scrollX, scrollY, screenshotId? }): Promise<null>`
- `set_value({ window, element_index, value }): Promise<null>`
- `drag({ window, from_x, from_y, to_x, to_y, screenshotId? }): Promise<null>`
- `perform_secondary_action({ window, element_index, action }): Promise<null>`
- `activate_window({ window }): Promise<null>`

Screenshots and coordinates use the same window-relative logical coordinate space. There is no standalone screenshot method.
