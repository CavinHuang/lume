#[cfg(any(target_os = "macos", test))]
use crate::{DesktopMouseButton, DesktopScrollDirection};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::windows_cursor_motion::{
    cursor_motion_frame_points, CursorBounds, CursorPoint, CursorVector,
};

pub const MACOS_EVENT_FLAG_MASK_SHIFT: u64 = 0x0002_0000;
pub const MACOS_EVENT_FLAG_MASK_CONTROL: u64 = 0x0004_0000;
pub const MACOS_EVENT_FLAG_MASK_ALTERNATE: u64 = 0x0008_0000;
pub const MACOS_EVENT_FLAG_MASK_COMMAND: u64 = 0x0010_0000;
pub const MACOS_LUME_GLOBAL_POINTER_FALLBACK_ENV: &str =
    "LUME_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS";
pub const MACOS_OPEN_COMPUTER_USE_GLOBAL_POINTER_FALLBACK_ENV: &str =
    "OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS";
pub const MACOS_LUME_VISUAL_POINTER_ENV: &str = "LUME_COMPUTER_USE_VISUAL_CURSOR";
pub const MACOS_OPEN_COMPUTER_USE_VISUAL_POINTER_ENV: &str = "OPEN_COMPUTER_USE_VISUAL_CURSOR";
pub const MACOS_NON_SETTABLE_SET_VALUE_ERROR: &str =
    "Cannot set a value for an element that is not settable";
const MACOS_VISIBLE_POINTER_FRAME_INTERVAL_SECONDS: f64 = 1.0 / 60.0;

#[derive(Clone, Debug, PartialEq)]
pub struct MacOSWindowInfo {
    pub window_id: u64,
    pub owner_pid: u32,
    pub bundle_identifier: Option<String>,
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
    pub screenshot_data_url: Option<String>,
    pub screenshot_error: Option<String>,
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
    pub settable: bool,
    pub actions: Vec<String>,
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

pub fn macos_resolve_action_point(
    window: &MacOSWindowInfo,
    params: &Value,
) -> Result<(i64, i64), Value> {
    if let Some(element_id) = params.get("elementId").and_then(Value::as_str) {
        let Some(element) = find_element_by_id(&window.elements, element_id) else {
            return Err(stale_element());
        };
        return Ok((
            rounded(element.x + element.width / 2.0),
            rounded(element.y + element.height / 2.0),
        ));
    }
    let Some(x) = numeric_param(params, "x") else {
        return Err(failed_action("x/y or elementId is required"));
    };
    let Some(y) = numeric_param(params, "y") else {
        return Err(failed_action("x/y or elementId is required"));
    };
    Ok((x, y))
}

pub fn macos_text_target_is_sensitive(window: &MacOSWindowInfo, params: &Value) -> bool {
    if let Some(element_id) = params.get("elementId").and_then(Value::as_str) {
        return find_element_by_id(&window.elements, element_id)
            .map(|element| element.sensitive)
            .unwrap_or(false);
    }
    focused_sensitive_element(&window.elements)
}

pub fn macos_preferred_click_actions(secondary: bool) -> &'static [&'static str] {
    if secondary {
        &["AXShowMenu"]
    } else {
        &["AXPress", "AXConfirm", "AXOpen"]
    }
}

pub fn macos_matching_secondary_action<'a>(
    actions: &'a [String],
    requested: &str,
) -> Option<&'a str> {
    let requested = requested.trim();
    actions
        .iter()
        .find(|action| action.eq_ignore_ascii_case(requested))
        .map(String::as_str)
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_click_event_codes(button: DesktopMouseButton) -> (u32, u32, u32) {
    match button {
        DesktopMouseButton::Left => (1, 2, 0),
        DesktopMouseButton::Right => (3, 4, 1),
        DesktopMouseButton::Middle => (25, 26, 2),
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_scroll_action_name(direction: DesktopScrollDirection) -> &'static str {
    match direction {
        DesktopScrollDirection::Up => "AXScrollUpByPage",
        DesktopScrollDirection::Down => "AXScrollDownByPage",
        DesktopScrollDirection::Left => "AXScrollLeftByPage",
        DesktopScrollDirection::Right => "AXScrollRightByPage",
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_integral_scroll_page_count(pages: f64) -> Option<u32> {
    let rounded = pages.round();
    if (pages - rounded).abs() >= 0.000_001 || rounded > u32::MAX as f64 {
        return None;
    }
    Some((rounded as u32).max(1))
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_scroll_wheel_deltas(
    direction: DesktopScrollDirection,
    pages: f64,
) -> (i32, i32) {
    let delta = (12.0 * pages).round().clamp(1.0, i32::MAX as f64) as i32;
    match direction {
        DesktopScrollDirection::Up => (delta, 0),
        DesktopScrollDirection::Down => (-delta, 0),
        DesktopScrollDirection::Left => (0, delta),
        DesktopScrollDirection::Right => (0, -delta),
    }
}

pub fn macos_set_value_attribute_is_settable(
    result: i32,
    settable: bool,
    attribute: &str,
) -> Result<bool, String> {
    if result == 0 {
        Ok(settable)
    } else {
        Err(format!(
            "AXUIElementIsAttributeSettable({attribute}) failed with {result}"
        ))
    }
}

pub fn macos_global_pointer_fallback_enabled_from(
    lume_value: Option<&str>,
    open_computer_use_value: Option<&str>,
) -> bool {
    truthy_env_flag(lume_value) || truthy_env_flag(open_computer_use_value)
}

pub fn macos_pointer_input_mode(global_pointer_fallback: bool) -> &'static str {
    if global_pointer_fallback {
        "physical_pointer"
    } else {
        "targeted_event"
    }
}

pub fn macos_click_requires_activation(global_pointer_fallback: bool) -> bool {
    global_pointer_fallback
}

pub fn macos_visible_pointer_enabled_from(
    lume_value: Option<&str>,
    open_computer_use_value: Option<&str>,
) -> bool {
    let Some(value) = lume_value.or(open_computer_use_value) else {
        return true;
    };
    !matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "no" | "off"
    )
}

pub fn macos_visible_pointer_mode(enabled: bool) -> &'static str {
    if enabled {
        "software_cursor"
    } else {
        "disabled"
    }
}

pub fn macos_visible_pointer_motion_points(
    start: (i64, i64),
    end: (i64, i64),
    bounds: (i64, i64, i64, i64),
) -> Vec<(i64, i64)> {
    if (start.0 - end.0).abs() <= 2 && (start.1 - end.1).abs() <= 2 {
        return vec![end];
    }
    let start = CursorPoint {
        x: start.0 as f64,
        y: start.1 as f64,
    };
    let end = CursorPoint {
        x: end.0 as f64,
        y: end.1 as f64,
    };
    cursor_motion_frame_points(
        start,
        end,
        CursorBounds::new(
            bounds.0 as f64,
            bounds.1 as f64,
            bounds.2 as f64,
            bounds.3 as f64,
        ),
        CursorVector::new(1.0, 0.0),
        CursorVector::new(1.0, 0.0),
        MACOS_VISIBLE_POINTER_FRAME_INTERVAL_SECONDS,
    )
    .into_iter()
    .map(|point| (point.x.round() as i64, point.y.round() as i64))
    .collect()
}

pub fn macos_key_chord(keys: &[&str]) -> Option<(u16, u64)> {
    let mut flags = 0_u64;
    let mut primary = None;
    for key in keys {
        match key.trim().to_ascii_uppercase().as_str() {
            "SHIFT" => flags |= MACOS_EVENT_FLAG_MASK_SHIFT,
            "CTRL" | "CONTROL" => flags |= MACOS_EVENT_FLAG_MASK_CONTROL,
            "ALT" | "OPTION" => flags |= MACOS_EVENT_FLAG_MASK_ALTERNATE,
            "CMD" | "COMMAND" | "META" | "SUPER" => flags |= MACOS_EVENT_FLAG_MASK_COMMAND,
            value => primary = macos_key_code(value),
        }
    }
    primary.map(|key_code| (key_code, flags))
}

pub fn first_visible_user_window(windows: &[MacOSWindowInfo]) -> Option<MacOSWindowInfo> {
    let visible = visible_user_windows(windows);
    visible
        .iter()
        .find(|window| window.is_focused)
        .copied()
        .or_else(|| visible.first().copied())
        .cloned()
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

fn screenshot_ref(window: &MacOSWindowInfo, include_pixels: bool) -> Value {
    let mut screenshot = json!({
        "id": screenshot_id(window),
        "width": rounded(window.width).max(0),
        "height": rounded(window.height).max(0),
        "origin": {
            "x": rounded(window.x),
            "y": rounded(window.y),
        },
        "mimeType": "image/png",
    });
    if include_pixels {
        if let Some(data_url) = normalized_optional_text(window.screenshot_data_url.as_deref()) {
            screenshot["dataUrl"] = Value::String(data_url);
        } else if let Some(error) = normalized_optional_text(window.screenshot_error.as_deref()) {
            screenshot["error"] = Value::String(error);
        }
    }
    screenshot
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
    if element.settable {
        value["settable"] = Value::Bool(true);
    }
    if !element.actions.is_empty() {
        value["actions"] = json!(element.actions);
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

fn find_element_by_id<'a>(
    elements: &'a [MacOSElementInfo],
    element_id: &str,
) -> Option<&'a MacOSElementInfo> {
    let path = element_id.strip_prefix("root.")?;
    let mut current = elements;
    let mut element = None;
    for part in path.split('.') {
        let index = part.parse::<usize>().ok()?;
        element = current.get(index);
        current = &element?.children;
    }
    element
}

fn focused_sensitive_element(elements: &[MacOSElementInfo]) -> bool {
    elements.iter().any(|element| {
        (element.focused && element.sensitive) || focused_sensitive_element(&element.children)
    })
}

fn numeric_param(params: &Value, name: &str) -> Option<i64> {
    params
        .get(name)
        .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(rounded)))
}

fn truthy_env_flag(value: Option<&str>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn macos_key_code(key: &str) -> Option<u16> {
    let code = match key {
        "A" => 0,
        "S" => 1,
        "D" => 2,
        "F" => 3,
        "H" => 4,
        "G" => 5,
        "Z" => 6,
        "X" => 7,
        "C" => 8,
        "V" => 9,
        "B" => 11,
        "Q" => 12,
        "W" => 13,
        "E" => 14,
        "R" => 15,
        "Y" => 16,
        "T" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "=" | "EQUAL" => 24,
        "9" => 25,
        "7" => 26,
        "-" | "MINUS" => 27,
        "8" => 28,
        "0" => 29,
        "]" | "RIGHTBRACKET" => 30,
        "O" => 31,
        "U" => 32,
        "[" | "LEFTBRACKET" => 33,
        "I" => 34,
        "P" => 35,
        "ENTER" | "RETURN" => 36,
        "L" => 37,
        "J" => 38,
        "'" | "QUOTE" => 39,
        "K" => 40,
        ";" | "SEMICOLON" => 41,
        "\\" | "BACKSLASH" => 42,
        "," | "COMMA" => 43,
        "/" | "SLASH" => 44,
        "N" => 45,
        "M" => 46,
        "." | "PERIOD" => 47,
        "TAB" => 48,
        "SPACE" => 49,
        "`" | "BACKQUOTE" => 50,
        "BACKSPACE" | "DELETE" => 51,
        "ESC" | "ESCAPE" => 53,
        "LEFT" | "ARROWLEFT" => 123,
        "RIGHT" | "ARROWRIGHT" => 124,
        "DOWN" | "ARROWDOWN" => 125,
        "UP" | "ARROWUP" => 126,
        _ => return None,
    };
    Some(code)
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
    normalized_optional_text(window.bundle_identifier.as_deref())
        .unwrap_or_else(|| format!("pid:{}", window.owner_pid))
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

fn stale_element() -> Value {
    json!({ "status": "stale_target", "message": "target element is unavailable" })
}

fn failed_action(message: &str) -> Value {
    json!({ "status": "failed", "message": message })
}

#[cfg(test)]
mod click_event_tests {
    use super::*;
    use crate::{DesktopMouseButton, DesktopScrollDirection};

    #[test]
    fn maps_all_supported_mouse_buttons_to_core_graphics_events() {
        assert_eq!(macos_click_event_codes(DesktopMouseButton::Left), (1, 2, 0));
        assert_eq!(
            macos_click_event_codes(DesktopMouseButton::Right),
            (3, 4, 1)
        );
        assert_eq!(
            macos_click_event_codes(DesktopMouseButton::Middle),
            (25, 26, 2)
        );
    }

    #[test]
    fn maps_scroll_directions_to_ax_actions_and_wheel_axes() {
        assert_eq!(
            macos_scroll_action_name(DesktopScrollDirection::Up),
            "AXScrollUpByPage"
        );
        assert_eq!(
            macos_scroll_action_name(DesktopScrollDirection::Right),
            "AXScrollRightByPage"
        );
        assert_eq!(
            macos_scroll_wheel_deltas(DesktopScrollDirection::Down, 1.5),
            (-18, 0)
        );
        assert_eq!(
            macos_scroll_wheel_deltas(DesktopScrollDirection::Left, 0.5),
            (0, 6)
        );
    }

    #[test]
    fn uses_ax_page_actions_only_for_integral_page_counts() {
        assert_eq!(macos_integral_scroll_page_count(2.0), Some(2));
        assert_eq!(macos_integral_scroll_page_count(0.5), None);
    }

    #[test]
    fn activates_apps_only_for_global_click_fallbacks() {
        assert!(!macos_click_requires_activation(false));
        assert!(macos_click_requires_activation(true));
    }
}
