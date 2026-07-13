use crate::DesktopBackend;
use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_SCREENSHOT_ID: AtomicU64 = AtomicU64::new(1);
const MAX_SCREENSHOTS: usize = 32;
const ELEMENT_SNAPSHOT_TTL_MS: u64 = 30_000;

#[derive(Default)]
pub struct ComputerUseProtocolAdapter {
    latest_elements: HashMap<u64, ElementSnapshot>,
    screenshots: HashMap<String, ScreenshotSnapshot>,
    latest_screenshots_by_window: HashMap<u64, Vec<String>>,
}

struct ElementSnapshot {
    index_to_platform_id: HashMap<u64, String>,
    fingerprints: HashMap<u64, ElementFingerprint>,
    captured_at: u64,
}

#[derive(Clone, Eq, PartialEq)]
struct ElementFingerprint {
    platform_id: String,
    role: String,
    name: String,
    sensitive: bool,
}

#[derive(Clone)]
struct ScreenshotSnapshot {
    window_id: u64,
    geometry: Value,
    transform: Option<ScreenshotTransform>,
}

#[derive(Clone)]
struct ScreenshotTransform {
    capture_left: i64,
    capture_top: i64,
    physical_width: f64,
    physical_height: f64,
    logical_width: f64,
    logical_height: f64,
}

impl ComputerUseProtocolAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn invoke<B: DesktopBackend>(
        &mut self,
        backend: &B,
        method: &str,
        params: &Value,
    ) -> Result<Value> {
        if method == "desktop_context.preflight_action" {
            return self.preflight_action(backend, params);
        }
        if let Some(internal_method) = method.strip_prefix("desktop_context.") {
            return backend.invoke(internal_method, params);
        }
        match method {
            "list_windows" => self.list_windows(backend),
            "get_window" => self.get_window(backend, params),
            "list_apps" => self.list_apps(backend),
            "launch_app" => self.null_action(backend, method, params),
            "get_window_state" => self.get_window_state(backend, params),
            "click"
            | "press_key"
            | "type_text"
            | "scroll"
            | "set_value"
            | "drag"
            | "perform_secondary_action"
            | "activate_window" => self.dispatch(backend, method, params),
            "take_screenshot" | "move_pointer" | "current_context" | "search_context"
            | "wait_for_state" => Err(anyhow!("method is not part of Computer Use v3: {method}")),
            // Permission diagnostics remain a private host facility.
            _ => backend.invoke(method, params),
        }
    }

    fn list_windows<B: DesktopBackend>(&self, backend: &B) -> Result<Value> {
        let result = checked_result(backend.invoke("list_windows", &json!({}))?)?;
        Ok(Value::Array(
            result["windows"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(canonical_window)
                .collect(),
        ))
    }

    fn list_apps<B: DesktopBackend>(&self, backend: &B) -> Result<Value> {
        let result = checked_result(backend.invoke("list_apps", &json!({}))?)?;
        let apps = result["apps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|app| {
                let id = app.get("id")?.as_str()?.trim();
                if id.is_empty() {
                    return None;
                }
                let windows = app["windows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(canonical_window)
                    .collect::<Vec<_>>();
                let mut output = json!({ "id": id, "windows": windows });
                copy_optional_string(&mut output, "displayName", app, "displayName");
                if output.get("displayName").is_none() {
                    copy_optional_string(&mut output, "displayName", app, "name");
                }
                copy_optional_bool(&mut output, "isRunning", app, "isRunning");
                copy_optional_string(&mut output, "lastUsedDate", app, "lastUsedDate");
                copy_optional_number(&mut output, "useCount", app, "useCount");
                Some(output)
            })
            .collect();
        Ok(Value::Array(apps))
    }

    fn get_window<B: DesktopBackend>(&self, backend: &B, params: &Value) -> Result<Value> {
        let window_id = params
            .get("id")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or_else(|| anyhow!("window id is required"))?;
        let result = checked_result(backend.invoke(
            "get_window",
            &json!({ "windowId": platform_window_id(window_id) }),
        )?)?;
        let window = canonical_window(&result["window"])
            .ok_or_else(|| anyhow!("platform window could not be rehydrated"))?;
        if let Some(expected_app) = params.get("app").and_then(Value::as_str) {
            if window["app"].as_str() != Some(expected_app) {
                return Err(anyhow!("window app changed before rehydration"));
            }
        }
        Ok(window)
    }

    fn get_window_state<B: DesktopBackend>(
        &mut self,
        backend: &B,
        params: &Value,
    ) -> Result<Value> {
        let window_id = canonical_window_id(params)?;
        let include_screenshot = params
            .get("include_screenshot")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let include_text = params
            .get("include_text")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let legacy = checked_result(backend.invoke(
            "get_window_state",
            &json!({
                "windowId": platform_window_id(window_id),
                "includeScreenshot": include_screenshot,
                "includeText": include_text,
            }),
        )?)?;
        let window = canonical_window(&legacy["window"])
            .ok_or_else(|| anyhow!("platform state has no canonical window"))?;
        let accessibility = if include_text {
            self.canonical_accessibility(window_id, &legacy)?
        } else {
            Value::Null
        };
        let screenshots = if include_screenshot {
            self.canonical_screenshots(window_id, &legacy)?
        } else {
            Vec::new()
        };
        Ok(json!({
            "window": window,
            "accessibility": accessibility,
            "screenshots": screenshots,
        }))
    }

    fn canonical_accessibility(&mut self, window_id: u64, legacy: &Value) -> Result<Value> {
        let origin = bounds_origin(&legacy["window"]);
        let dpi = legacy["window"]
            .get("dpi")
            .and_then(Value::as_f64)
            .unwrap_or(96.0);
        let mut records = Vec::new();
        let mut next_index = 0_u64;
        let mut index_to_platform_id = HashMap::new();
        let mut platform_id_to_index = HashMap::new();
        let mut fingerprints = HashMap::new();
        index_elements(
            legacy["accessibility"]["tree"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            0,
            origin,
            dpi,
            &mut next_index,
            &mut records,
            &mut index_to_platform_id,
            &mut platform_id_to_index,
            &mut fingerprints,
        );
        self.latest_elements.insert(
            window_id,
            ElementSnapshot {
                index_to_platform_id,
                fingerprints,
                captured_at: now_millis(),
            },
        );
        let title = legacy["window"]["title"].as_str().unwrap_or_default();
        let app = legacy["window"]["appName"]
            .as_str()
            .or_else(|| legacy["window"]["appId"].as_str())
            .unwrap_or_default();
        let mut lines = vec![format!("Window: \"{title}\", App: {app}.")];
        lines.extend(records.iter().map(format_element_line));
        let mut accessibility = json!({ "tree": lines.join("\n") });
        if let Some(focused) = focused_element_line(
            &legacy["accessibility"]["focusedElement"],
            origin,
            &platform_id_to_index,
        ) {
            accessibility["focused_element"] = Value::String(focused);
        }
        copy_nonempty_string(
            &mut accessibility,
            "selected_text",
            &legacy["accessibility"]["selectedText"],
        );
        copy_nonempty_string(
            &mut accessibility,
            "document_text",
            &legacy["accessibility"]["documentText"],
        );
        Ok(accessibility)
    }

    fn canonical_screenshots(&mut self, window_id: u64, legacy: &Value) -> Result<Vec<Value>> {
        let platform_screenshots = legacy["screenshots"]
            .as_array()
            .ok_or_else(|| anyhow!("screenshot pixels unavailable"))?;
        let mut screenshots = Vec::new();
        for platform in platform_screenshots {
            let url = platform
                .get("dataUrl")
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())
                .ok_or_else(|| anyhow!("screenshot pixels unavailable"))?;
            let id = unique_screenshot_id(window_id);
            let mut screenshot = json!({
                "id": id,
                "url": url,
                "zIndex": platform.get("zIndex").and_then(Value::as_i64).unwrap_or(0),
            });
            copy_optional_number(&mut screenshot, "width", platform, "width");
            copy_optional_number(&mut screenshot, "height", platform, "height");
            if let Some(origin) = platform.get("origin") {
                copy_optional_number(&mut screenshot, "originX", origin, "x");
                copy_optional_number(&mut screenshot, "originY", origin, "y");
            }
            self.screenshots.insert(
                id.clone(),
                ScreenshotSnapshot {
                    window_id,
                    geometry: window_geometry(&legacy["window"]),
                    transform: screenshot_transform(platform),
                },
            );
            screenshots.push(screenshot);
        }
        if screenshots.is_empty() {
            return Err(anyhow!("screenshot pixels unavailable"));
        }
        let current_ids = screenshots
            .iter()
            .filter_map(|screenshot| {
                screenshot
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        if let Some(previous) = self
            .latest_screenshots_by_window
            .insert(window_id, current_ids)
        {
            for id in previous {
                self.screenshots.remove(&id);
            }
        }
        while self.screenshots.len() > MAX_SCREENSHOTS {
            if let Some(oldest) = self.screenshots.keys().min().cloned() {
                self.screenshots.remove(&oldest);
            }
        }
        Ok(screenshots)
    }

    fn null_action<B: DesktopBackend>(
        &self,
        backend: &B,
        method: &str,
        params: &Value,
    ) -> Result<Value> {
        checked_result(backend.invoke(method, params)?)?;
        Ok(Value::Null)
    }

    fn preflight_action<B: DesktopBackend>(&self, backend: &B, params: &Value) -> Result<Value> {
        let window_id = canonical_window_id(params)?;
        if let Some(index) = params.get("element_index").and_then(Value::as_u64) {
            let snapshot = self.latest_elements.get(&window_id).ok_or_else(|| {
                anyhow!("element_index requires a current accessibility snapshot")
            })?;
            if now_millis().saturating_sub(snapshot.captured_at) > ELEMENT_SNAPSHOT_TTL_MS {
                return Err(anyhow!("element_index snapshot is stale"));
            }
            let element = snapshot
                .fingerprints
                .get(&index)
                .ok_or_else(|| anyhow!("element_index is not present in the latest snapshot"))?;
            return Ok(json!({
                "role": element.role,
                "targetLabel": element.name,
                "sensitive": element.sensitive,
            }));
        }

        let window_result = checked_result(backend.invoke(
            "get_window",
            &json!({ "windowId": platform_window_id(window_id) }),
        )?)?;
        if !window_matches(&window_result["window"], &params["window"]) {
            return Err(anyhow!("window identity changed before action preflight"));
        }
        let mut legacy = params.as_object().cloned().unwrap_or_default();
        legacy.remove("window");
        legacy.remove("element_index");
        legacy.remove("screenshotId");
        legacy.insert(
            "windowId".to_owned(),
            Value::String(platform_window_id(window_id)),
        );
        map_logical_coordinate(&mut legacy, "x", "y", &window_result["window"]);
        let current_state = checked_result(backend.invoke(
            "get_window_state",
            &json!({
                "windowId": platform_window_id(window_id),
                "includeScreenshot": false,
                "includeText": true,
            }),
        )?)?;
        if let (Some(x), Some(y)) = (
            legacy.get("x").and_then(Value::as_i64),
            legacy.get("y").and_then(Value::as_i64),
        ) {
            if let Some(element) = find_platform_element_at_point(
                current_state["accessibility"]["tree"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                x,
                y,
            ) {
                let sensitive = element
                    .get("sensitive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                return Ok(json!({
                    "role": element.get("role").and_then(Value::as_str).unwrap_or("unknown"),
                    "targetLabel": if sensitive { "" } else { element.get("name").and_then(Value::as_str).unwrap_or("") },
                    "sensitive": sensitive,
                }));
            }
        }
        let platform = checked_result(backend.invoke("preflight_action", &Value::Object(legacy))?)?;
        let mut output = json!({});
        copy_optional_string(&mut output, "role", &platform, "role");
        copy_optional_string(&mut output, "targetLabel", &platform, "name");
        copy_optional_string(&mut output, "recipient", &platform, "recipient");
        copy_optional_bool(&mut output, "sensitive", &platform, "sensitive");
        Ok(output)
    }

    fn dispatch<B: DesktopBackend>(
        &mut self,
        backend: &B,
        method: &str,
        params: &Value,
    ) -> Result<Value> {
        let window_id = canonical_window_id(params)?;
        let window_result = checked_result(backend.invoke(
            "get_window",
            &json!({ "windowId": platform_window_id(window_id) }),
        )?)?;
        if !window_matches(&window_result["window"], &params["window"]) {
            return Err(anyhow!("window identity changed before dispatch"));
        }
        let mut screenshot_transform = None;
        if let Some(screenshot_id) = params.get("screenshotId").and_then(Value::as_str) {
            let snapshot = self
                .screenshots
                .get(screenshot_id)
                .ok_or_else(|| anyhow!("screenshot is stale or unknown"))?;
            if snapshot.window_id != window_id
                || snapshot.geometry != window_geometry(&window_result["window"])
                || self
                    .latest_screenshots_by_window
                    .get(&window_id)
                    .is_none_or(|ids| !ids.iter().any(|id| id == screenshot_id))
            {
                return Err(anyhow!("screenshot does not match the current window"));
            }
            screenshot_transform = snapshot.transform.clone();
        }

        let mut legacy = params.as_object().cloned().unwrap_or_default();
        legacy.remove("window");
        legacy.remove("screenshotId");
        legacy.insert(
            "windowId".to_owned(),
            Value::String(platform_window_id(window_id)),
        );
        rename_field(&mut legacy, "click_count", "clickCount");
        rename_field(&mut legacy, "mouse_button", "mouseButton");
        rename_field(&mut legacy, "from_x", "fromX");
        rename_field(&mut legacy, "from_y", "fromY");
        rename_field(&mut legacy, "to_x", "toX");
        rename_field(&mut legacy, "to_y", "toY");

        if let Some(index) = params.get("element_index").and_then(Value::as_u64) {
            let snapshot = self.latest_elements.get(&window_id).ok_or_else(|| {
                anyhow!("element_index requires a current accessibility snapshot")
            })?;
            if now_millis().saturating_sub(snapshot.captured_at) > ELEMENT_SNAPSHOT_TTL_MS {
                return Err(anyhow!("element_index snapshot is stale"));
            }
            let platform_id = snapshot
                .index_to_platform_id
                .get(&index)
                .ok_or_else(|| anyhow!("element_index is not present in the latest snapshot"))?;
            let expected_fingerprint = snapshot
                .fingerprints
                .get(&index)
                .ok_or_else(|| anyhow!("element fingerprint is unavailable"))?;
            let current_state = checked_result(backend.invoke(
                "get_window_state",
                &json!({ "windowId": platform_window_id(window_id), "includeScreenshot": false }),
            )?)?;
            let current_element = find_platform_element(
                current_state["accessibility"]["tree"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                platform_id,
            )
            .ok_or_else(|| anyhow!("element changed before dispatch"))?;
            if element_fingerprint(current_element) != *expected_fingerprint {
                return Err(anyhow!("element changed before dispatch"));
            }
            legacy.remove("element_index");
            legacy.insert("elementId".to_owned(), Value::String(platform_id.clone()));
        }

        if has_coordinates(&legacy) {
            for (x, y) in [("x", "y"), ("fromX", "fromY"), ("toX", "toY")] {
                if let Some(transform) = &screenshot_transform {
                    map_screenshot_coordinate(&mut legacy, x, y, transform);
                } else {
                    map_logical_coordinate(&mut legacy, x, y, &window_result["window"]);
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            if method != "activate_window" {
                checked_result(backend.invoke(
                    "activate_window",
                    &json!({ "windowId": platform_window_id(window_id) }),
                )?)?;
            }
            if method == "scroll" {
                dispatch_macos_scroll(backend, &legacy)?;
                return Ok(Value::Null);
            }
        }
        checked_result(backend.invoke(method, &Value::Object(legacy))?)?;
        Ok(Value::Null)
    }
}

#[cfg(target_os = "macos")]
fn dispatch_macos_scroll<B: DesktopBackend>(
    backend: &B,
    legacy: &Map<String, Value>,
) -> Result<()> {
    let scroll_x = legacy
        .get("scrollX")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    let scroll_y = legacy
        .get("scrollY")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    for (delta, positive, negative) in [(scroll_y, "down", "up"), (scroll_x, "right", "left")] {
        if delta == 0.0 {
            continue;
        }
        let mut params = legacy.clone();
        params.remove("scrollX");
        params.remove("scrollY");
        params.insert(
            "direction".to_owned(),
            Value::String(if delta > 0.0 { positive } else { negative }.to_owned()),
        );
        params.insert("pages".to_owned(), json!((delta.abs() / 120.0).max(0.01)));
        checked_result(backend.invoke("scroll", &Value::Object(params))?)?;
    }
    Ok(())
}

#[derive(Clone)]
struct IndexedElement {
    index: u64,
    depth: usize,
    role: String,
    name: String,
    value: Option<String>,
    enabled: bool,
    focused: bool,
    bounds: Option<(i64, i64, i64, i64)>,
}

#[allow(clippy::too_many_arguments)]
fn index_elements(
    elements: &[Value],
    depth: usize,
    origin: (i64, i64),
    dpi: f64,
    next_index: &mut u64,
    records: &mut Vec<IndexedElement>,
    index_to_platform_id: &mut HashMap<u64, String>,
    platform_id_to_index: &mut HashMap<String, u64>,
    fingerprints: &mut HashMap<u64, ElementFingerprint>,
) {
    for element in elements {
        let index = *next_index;
        *next_index += 1;
        let role = element
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let sensitive = element.get("sensitive").and_then(Value::as_bool) == Some(true);
        let name = if sensitive {
            String::new()
        } else {
            element
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        records.push(IndexedElement {
            index,
            depth,
            role,
            name,
            value: (!sensitive)
                .then(|| element.get("value").and_then(Value::as_str))
                .flatten()
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            enabled: element
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            focused: element
                .get("focused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            bounds: relative_bounds(element.get("bounds"), origin, dpi),
        });
        if let Some(id) = element.get("id").and_then(Value::as_str) {
            index_to_platform_id.insert(index, id.to_owned());
            platform_id_to_index.insert(id.to_owned(), index);
            fingerprints.insert(index, element_fingerprint(element));
        }
        index_elements(
            element
                .get("children")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            depth + 1,
            origin,
            dpi,
            next_index,
            records,
            index_to_platform_id,
            platform_id_to_index,
            fingerprints,
        );
    }
}

fn format_element_line(element: &IndexedElement) -> String {
    let mut line = format!(
        "{}{} {}",
        "\t".repeat(element.depth + 1),
        element.index,
        element.role
    );
    if !element.name.is_empty() {
        line.push(' ');
        line.push_str(&element.name);
    }
    if let Some(value) = &element.value {
        line.push_str(&format!(" value={value:?}"));
    }
    if let Some((x, y, width, height)) = element.bounds {
        line.push_str(&format!(" bounds=({x},{y},{width},{height})"));
    }
    if !element.enabled {
        line.push_str(" (disabled)");
    }
    if element.focused {
        line.push_str(" (focused)");
    }
    line
}

fn focused_element_line(
    element: &Value,
    _origin: (i64, i64),
    indices: &HashMap<String, u64>,
) -> Option<String> {
    let id = element.get("id")?.as_str()?;
    let index = *indices.get(id)?;
    let role = element
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let name = if element.get("sensitive").and_then(Value::as_bool) == Some(true) {
        ""
    } else {
        element
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    Some(format!(
        "{index} {role}{} (focused)",
        if name.is_empty() {
            String::new()
        } else {
            format!(" {name}")
        }
    ))
}

fn canonical_window(value: &Value) -> Option<Value> {
    let id = platform_numeric_window_id(value.get("id")?.as_str()?)?;
    let app = value
        .get("appId")
        .or_else(|| value.get("app"))?
        .as_str()?
        .trim();
    if app.is_empty() {
        return None;
    }
    let mut window = json!({ "id": id, "app": app });
    copy_optional_string(&mut window, "title", value, "title");
    Some(window)
}

fn canonical_window_id(params: &Value) -> Result<u64> {
    params
        .get("window")
        .and_then(|window| window.get("id"))
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or_else(|| anyhow!("canonical window is required"))
}

fn platform_numeric_window_id(value: &str) -> Option<u64> {
    value.rsplit(':').next()?.parse().ok()
}

#[cfg(target_os = "macos")]
fn platform_window_id(id: u64) -> String {
    format!("macos:{id}")
}

#[cfg(not(target_os = "macos"))]
fn platform_window_id(id: u64) -> String {
    format!("win:{id}")
}

fn window_matches(platform: &Value, canonical: &Value) -> bool {
    let Some(actual) = canonical_window(platform) else {
        return false;
    };
    if actual["id"] != canonical["id"] || actual["app"] != canonical["app"] {
        return false;
    }
    canonical
        .get("title")
        .and_then(Value::as_str)
        .is_none_or(|title| actual.get("title").and_then(Value::as_str) == Some(title))
}

fn find_platform_element<'a>(elements: &'a [Value], platform_id: &str) -> Option<&'a Value> {
    for element in elements {
        if element.get("id").and_then(Value::as_str) == Some(platform_id) {
            return Some(element);
        }
        if let Some(found) = find_platform_element(
            element
                .get("children")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            platform_id,
        ) {
            return Some(found);
        }
    }
    None
}

fn find_platform_element_at_point(elements: &[Value], x: i64, y: i64) -> Option<&Value> {
    for element in elements.iter().rev() {
        let contains = element.get("bounds").is_some_and(|bounds| {
            let left = bounds.get("x").and_then(Value::as_i64).unwrap_or(i64::MAX);
            let top = bounds.get("y").and_then(Value::as_i64).unwrap_or(i64::MAX);
            let width = bounds
                .get("width")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let height = bounds
                .get("height")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            x >= left && y >= top && x < left + width && y < top + height
        });
        if !contains {
            continue;
        }
        if let Some(found) = find_platform_element_at_point(
            element
                .get("children")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            x,
            y,
        ) {
            return Some(found);
        }
        return Some(element);
    }
    None
}

fn element_fingerprint(element: &Value) -> ElementFingerprint {
    let sensitive = element
        .get("sensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    ElementFingerprint {
        platform_id: element
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        role: element
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        name: if sensitive {
            String::new()
        } else {
            element
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        },
        sensitive,
    }
}

fn relative_bounds(
    value: Option<&Value>,
    origin: (i64, i64),
    dpi: f64,
) -> Option<(i64, i64, i64, i64)> {
    let bounds = value?.as_object()?;
    let scale = 96.0 / dpi.max(1.0);
    Some((
        ((bounds.get("x")?.as_i64()? - origin.0) as f64 * scale).round() as i64,
        ((bounds.get("y")?.as_i64()? - origin.1) as f64 * scale).round() as i64,
        (bounds.get("width")?.as_i64()? as f64 * scale).round() as i64,
        (bounds.get("height")?.as_i64()? as f64 * scale).round() as i64,
    ))
}

fn bounds_origin(window: &Value) -> (i64, i64) {
    (
        window["bounds"]["x"].as_i64().unwrap_or_default(),
        window["bounds"]["y"].as_i64().unwrap_or_default(),
    )
}

fn has_coordinates(params: &Map<String, Value>) -> bool {
    ["x", "y", "fromX", "fromY", "toX", "toY"]
        .iter()
        .any(|key| params.get(*key).and_then(Value::as_f64).is_some())
}

fn map_logical_coordinate(
    params: &mut Map<String, Value>,
    x_key: &str,
    y_key: &str,
    window: &Value,
) {
    let (origin_x, origin_y) = bounds_origin(window);
    let scale = window.get("dpi").and_then(Value::as_f64).unwrap_or(96.0) / 96.0;
    if let Some(value) = params.get(x_key).and_then(Value::as_f64) {
        params.insert(
            x_key.to_owned(),
            json!(origin_x + (value * scale).round() as i64),
        );
    }
    if let Some(value) = params.get(y_key).and_then(Value::as_f64) {
        params.insert(
            y_key.to_owned(),
            json!(origin_y + (value * scale).round() as i64),
        );
    }
}

fn map_screenshot_coordinate(
    params: &mut Map<String, Value>,
    x_key: &str,
    y_key: &str,
    transform: &ScreenshotTransform,
) {
    if let Some(value) = params.get(x_key).and_then(Value::as_f64) {
        params.insert(
            x_key.to_owned(),
            json!(
                transform.capture_left
                    + (value * transform.physical_width / transform.logical_width).round() as i64
            ),
        );
    }
    if let Some(value) = params.get(y_key).and_then(Value::as_f64) {
        params.insert(
            y_key.to_owned(),
            json!(
                transform.capture_top
                    + (value * transform.physical_height / transform.logical_height).round() as i64
            ),
        );
    }
}

fn screenshot_transform(value: &Value) -> Option<ScreenshotTransform> {
    Some(ScreenshotTransform {
        capture_left: value.get("captureLeft")?.as_i64()?,
        capture_top: value.get("captureTop")?.as_i64()?,
        physical_width: value.get("physicalWidth")?.as_f64()?.max(1.0),
        physical_height: value.get("physicalHeight")?.as_f64()?.max(1.0),
        logical_width: value.get("width")?.as_f64()?.max(1.0),
        logical_height: value.get("height")?.as_f64()?.max(1.0),
    })
}

fn window_geometry(window: &Value) -> Value {
    json!({
        "bounds": window.get("bounds").cloned().unwrap_or(Value::Null),
        "dpi": window.get("dpi").cloned().unwrap_or(json!(96)),
    })
}

fn rename_field(params: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = params.remove(from) {
        params.insert(to.to_owned(), value);
    }
}

fn checked_result(value: Value) -> Result<Value> {
    match value.get("status").and_then(Value::as_str) {
        None | Some("ok") => Ok(value),
        Some(_) => Err(anyhow!(
            "{}",
            value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("desktop host request failed")
        )),
    }
}

fn copy_nonempty_string(output: &mut Value, key: &str, value: &Value) {
    if let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) {
        output[key] = Value::String(text.to_owned());
    }
}

fn copy_optional_string(output: &mut Value, target: &str, source: &Value, source_key: &str) {
    if let Some(value) = source
        .get(source_key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        output[target] = Value::String(value.to_owned());
    }
}

fn copy_optional_bool(output: &mut Value, target: &str, source: &Value, source_key: &str) {
    if let Some(value) = source.get(source_key).and_then(Value::as_bool) {
        output[target] = Value::Bool(value);
    }
}

fn copy_optional_number(output: &mut Value, target: &str, source: &Value, source_key: &str) {
    if let Some(value) = source.get(source_key).and_then(Value::as_number) {
        output[target] = Value::Number(value.clone());
    }
}

fn unique_screenshot_id(window_id: u64) -> String {
    format!(
        "screenshot:{window_id}:{}:{}",
        now_millis(),
        NEXT_SCREENSHOT_ID.fetch_add(1, Ordering::Relaxed),
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
