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
    pub document_text: Option<String>,
    pub selected_text: Option<String>,
    pub elements: Vec<MacOSElementInfo>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MacOSElementInfo {
    pub role: String,
    pub title: String,
    pub value: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub enabled: bool,
    pub focused: bool,
    pub sensitive: bool,
    pub children: Vec<MacOSElementInfo>,
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

pub fn macos_get_window_result(window: Option<MacOSWindowInfo>) -> Value {
    match window {
        Some(window) => json!({ "status": "ok", "window": window_json(&window) }),
        None => stale_target(),
    }
}

pub fn macos_current_context_result(window: &MacOSWindowInfo, include_screenshot: bool) -> Value {
    let window_value = window_json(window);
    let visible_text = context_visible_text(window);
    let screenshot = screenshot_ref(window, include_screenshot);
    let mut snapshot = json!({
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
    });
    if let Some(selected_text) = normalized_optional_text(window.selected_text.as_deref()) {
        snapshot["snapshot"]["selectedText"] = Value::String(selected_text);
    }
    snapshot
}

pub fn macos_get_window_state_result(window: &MacOSWindowInfo, include_screenshot: bool) -> Value {
    let tree = element_tree_json(&window.elements);
    let focused = focused_element(&tree).unwrap_or(Value::Null);
    let visible_text = context_visible_text(window);
    json!({
        "status": "ok",
        "window": window_json(window),
        "revision": window_revision(window),
        "capturedAt": now_millis(),
        "screenshots": [screenshot_ref(window, include_screenshot)],
        "accessibility": {
            "tree": tree,
            "focusedElement": focused,
            "selectedText": normalized_optional_text(window.selected_text.as_deref()).unwrap_or_default(),
            "documentText": visible_text,
            "visibleText": visible_text,
            "truncated": false,
        },
    })
}

pub fn macos_wait_for_state_result(window: Option<MacOSWindowInfo>, params: &Value) -> Value {
    let Some(window) = window else {
        return stale_target();
    };
    let state = macos_get_window_state_result(
        &window,
        params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
    );
    if macos_state_matches(&state, params) {
        return state;
    }
    json!({
        "status": "timeout",
        "message": "desktop window state did not match before timeout"
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
    if let Some(text) = normalized_optional_text(window.document_text.as_deref()) {
        return text;
    }
    let element_text = element_document_text(&window.elements);
    if !element_text.is_empty() {
        return element_text;
    }
    if window.title.trim().is_empty() {
        window.owner_name.trim().to_owned()
    } else {
        window.title.trim().to_owned()
    }
}

fn element_tree_json(elements: &[MacOSElementInfo]) -> Vec<Value> {
    elements
        .iter()
        .enumerate()
        .map(|(index, element)| element_json(element, &format!("root.{index}")))
        .collect()
}

fn element_json(element: &MacOSElementInfo, id: &str) -> Value {
    let mut value = json!({
        "id": id,
        "role": normalize_role(&element.role),
        "name": element_name(element),
        "bounds": {
            "x": rounded(element.x),
            "y": rounded(element.y),
            "width": rounded(element.width),
            "height": rounded(element.height),
        },
        "enabled": element.enabled,
        "focused": element.focused,
    });
    if element.sensitive {
        value["sensitive"] = Value::Bool(true);
    } else if let Some(text) = normalized_optional_text(Some(&element.value)) {
        value["value"] = Value::String(text);
    }
    let children = element
        .children
        .iter()
        .enumerate()
        .map(|(index, child)| element_json(child, &format!("{id}.{index}")))
        .collect::<Vec<_>>();
    if !children.is_empty() {
        value["children"] = Value::Array(children);
    }
    value
}

fn focused_element(elements: &[Value]) -> Option<Value> {
    for element in elements {
        if element.get("focused").and_then(Value::as_bool) == Some(true) {
            return Some(element.clone());
        }
        if let Some(children) = element.get("children").and_then(Value::as_array) {
            if let Some(focused) = focused_element(children) {
                return Some(focused);
            }
        }
    }
    None
}

fn macos_state_matches(state: &Value, params: &Value) -> bool {
    if state.get("status").and_then(Value::as_str) != Some("ok") {
        return false;
    }
    if let Some(title) = params.get("titleContains").and_then(Value::as_str) {
        if !state["window"]["title"]
            .as_str()
            .unwrap_or_default()
            .contains(title)
        {
            return false;
        }
    }
    if let Some(previous) = params.get("revisionNot").and_then(Value::as_str) {
        if state.get("revision").and_then(Value::as_str) == Some(previous) {
            return false;
        }
    }
    if let Some(focused) = params.get("focused").and_then(Value::as_bool) {
        if state["window"]["focused"].as_bool() != Some(focused) {
            return false;
        }
    }
    true
}

fn element_document_text(elements: &[MacOSElementInfo]) -> String {
    let mut lines = Vec::<String>::new();
    collect_element_text(elements, &mut lines);
    lines.join("\n")
}

fn collect_element_text(elements: &[MacOSElementInfo], lines: &mut Vec<String>) {
    for element in elements {
        if !element.sensitive {
            for value in [element.title.as_str(), element.value.as_str()] {
                if let Some(text) = normalized_optional_text(Some(value)) {
                    if !lines.iter().any(|line| line == &text) {
                        lines.push(text);
                    }
                }
            }
        }
        collect_element_text(&element.children, lines);
    }
}

fn element_name(element: &MacOSElementInfo) -> String {
    normalized_optional_text(Some(&element.title))
        .or_else(|| {
            (!element.sensitive)
                .then(|| normalized_optional_text(Some(&element.value)))
                .flatten()
        })
        .unwrap_or_else(|| normalize_role(&element.role))
}

fn normalize_role(role: &str) -> String {
    let raw = role
        .trim()
        .strip_prefix("AX")
        .unwrap_or_else(|| role.trim())
        .to_ascii_lowercase();
    match raw.as_str() {
        "textarea" => "text_area".to_owned(),
        "textfield" => "text_field".to_owned(),
        "checkbox" => "checkbox".to_owned(),
        "radiobutton" => "radio_button".to_owned(),
        "popbutton" => "pop_button".to_owned(),
        "statictext" => "static_text".to_owned(),
        "scrollarea" => "scroll_area".to_owned(),
        _ => raw,
    }
}

fn normalized_optional_text(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    (!text.is_empty()).then(|| text.to_owned())
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

fn stale_target() -> Value {
    json!({ "status": "stale_target", "message": "target window is unavailable" })
}
