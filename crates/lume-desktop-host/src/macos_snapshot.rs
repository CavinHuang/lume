use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct MacOSWindowInfo {
    pub window_id: u64,
    pub owner_pid: u32,
    pub owner_name: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub layer: i64,
    pub is_onscreen: bool,
    pub is_focused: bool,
}

pub fn macos_list_windows_result(windows: &[MacOSWindowInfo], app_filter: Option<&str>) -> Value {
    let windows = visible_user_windows(windows)
        .into_iter()
        .map(window_json)
        .filter(|window| app_filter.is_none_or(|app_id| window["appId"] == app_id))
        .collect::<Vec<_>>();
    json!({ "status": "ok", "windows": windows })
}

pub fn macos_list_apps_result(windows: &[MacOSWindowInfo]) -> Value {
    let mut apps = BTreeMap::<String, Value>::new();
    for window in visible_user_windows(windows) {
        let app_id = app_id(window);
        apps.entry(app_id.clone()).or_insert_with(|| {
            json!({
                "id": app_id,
                "name": window.owner_name,
                "processId": window.owner_pid,
                "platformId": window.owner_pid.to_string(),
            })
        });
    }
    json!({ "status": "ok", "apps": apps.into_values().collect::<Vec<_>>() })
}

pub fn macos_current_context_result(window: &MacOSWindowInfo, include_screenshot: bool) -> Value {
    let window_value = window_json(window);
    let visible_text = context_visible_text(window);
    let screenshot = screenshot_ref(window, include_screenshot);
    json!({
        "status": "ok",
        "snapshot": {
            "id": format!("foreground:macos:{}:{}", window.window_id, now_millis()),
            "app": {
                "id": app_id(window),
                "name": window.owner_name,
                "processId": window.owner_pid,
            },
            "window": window_value,
            "capturedAt": now_millis(),
            "eventType": "foreground_changed",
            "visibleText": visible_text,
            "screenshotId": screenshot["id"],
            "screenshots": [screenshot],
            "untrusted": true,
        }
    })
}

pub fn macos_get_window_state_result(window: &MacOSWindowInfo, include_screenshot: bool) -> Value {
    let visible_text = context_visible_text(window);
    json!({
        "status": "ok",
        "window": window_json(window),
        "revision": window_revision(window),
        "capturedAt": now_millis(),
        "screenshots": [screenshot_ref(window, include_screenshot)],
        "accessibility": {
            "tree": [],
            "focusedElement": Value::Null,
            "selectedText": "",
            "documentText": visible_text,
            "visibleText": visible_text,
            "truncated": false,
        },
    })
}

pub fn first_visible_user_window(windows: &[MacOSWindowInfo]) -> Option<MacOSWindowInfo> {
    visible_user_windows(windows).into_iter().next().cloned()
}

pub fn find_macos_window(windows: &[MacOSWindowInfo], window_id: &str) -> Option<MacOSWindowInfo> {
    let raw_id = window_id.strip_prefix("macos:")?.parse::<u64>().ok()?;
    visible_user_windows(windows)
        .into_iter()
        .find(|window| window.window_id == raw_id)
        .cloned()
}

fn visible_user_windows(windows: &[MacOSWindowInfo]) -> Vec<&MacOSWindowInfo> {
    windows
        .iter()
        .filter(|window| {
            window.is_onscreen
                && window.layer == 0
                && window.width > 0.0
                && window.height > 0.0
                && (!window.owner_name.trim().is_empty() || !window.title.trim().is_empty())
        })
        .collect()
}

fn window_json(window: &MacOSWindowInfo) -> Value {
    json!({
        "id": window_id(window),
        "appId": app_id(window),
        "appName": window.owner_name,
        "title": context_visible_text(window),
        "bounds": {
            "x": rounded(window.x),
            "y": rounded(window.y),
            "width": rounded(window.width),
            "height": rounded(window.height),
        },
        "focused": window.is_focused,
        "minimized": false,
        "processId": window.owner_pid,
        "platformId": window.window_id.to_string(),
    })
}

fn screenshot_ref(window: &MacOSWindowInfo, _include_pixels: bool) -> Value {
    json!({
        "id": screenshot_id(window),
        "width": rounded(window.width).max(0),
        "height": rounded(window.height).max(0),
        "origin": {
            "x": rounded(window.x),
            "y": rounded(window.y),
        },
        "mimeType": "image/png",
    })
}

fn context_visible_text(window: &MacOSWindowInfo) -> String {
    if window.title.trim().is_empty() {
        window.owner_name.trim().to_owned()
    } else {
        window.title.trim().to_owned()
    }
}

fn app_id(window: &MacOSWindowInfo) -> String {
    format!("pid:{}", window.owner_pid)
}

fn window_id(window: &MacOSWindowInfo) -> String {
    format!("macos:{}", window.window_id)
}

fn screenshot_id(window: &MacOSWindowInfo) -> String {
    format!(
        "screenshot:{}:{}",
        window_id(window),
        window_revision(window)
    )
}

fn window_revision(window: &MacOSWindowInfo) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}",
        window_id(window),
        context_visible_text(window),
        rounded(window.x),
        rounded(window.y),
        rounded(window.width),
        rounded(window.height),
    )
}

fn rounded(value: f64) -> i64 {
    value.round() as i64
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
