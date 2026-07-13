use crate::DesktopBackend;
use anyhow::Result;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_SNAPSHOT_ID: AtomicU64 = AtomicU64::new(1);
const MAX_STATE_SNAPSHOTS: usize = 32;

#[derive(Default)]
pub struct ComputerUseProtocolAdapter {
    states: HashMap<String, ElementSnapshot>,
    screenshots: HashMap<String, u64>,
    latest_screenshot_by_window: HashMap<u64, String>,
}

struct ElementSnapshot {
    window_id: u64,
    index_to_platform_id: HashMap<u64, String>,
    fingerprints: HashMap<u64, ElementFingerprint>,
}

#[derive(Clone, Eq, PartialEq)]
struct ElementFingerprint {
    platform_id: String,
    role: String,
    name: String,
    sensitive: bool,
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
        if let Some(internal_method) = method.strip_prefix("desktop_context.") {
            return backend.invoke(internal_method, params);
        }
        match method {
            "list_apps" => self.list_apps(backend),
            "list_windows" => self.list_windows(backend, params),
            "get_window" => self.get_window(backend, params),
            "get_window_state" => self.get_window_state(backend, params),
            "take_screenshot" => self.take_screenshot(backend, params),
            "launch_app" => backend.invoke(method, params),
            "activate_window"
            | "click"
            | "press_key"
            | "type_text"
            | "scroll"
            | "set_value"
            | "drag"
            | "perform_secondary_action" => self.dispatch(backend, method, params),
            "move_pointer" | "current_context" | "search_context" | "wait_for_state" => Ok(json!({
                "status": "failed",
                "message": format!("method is not part of Computer Use v2: {method}")
            })),
            // Permission diagnostics remain a host facility but are not Agent-visible tools.
            _ => backend.invoke(method, params),
        }
    }

    fn list_windows<B: DesktopBackend>(&self, backend: &B, params: &Value) -> Result<Value> {
        let result = backend.invoke("list_windows", &json!({}))?;
        if result["status"] != "ok" {
            return Ok(result);
        }
        let app_filter = params.get("app").and_then(Value::as_str);
        let windows = result["windows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(canonical_window)
            .filter(|window| app_filter.is_none_or(|app| window["app"].as_str() == Some(app)))
            .collect::<Vec<_>>();
        Ok(json!({ "status": "ok", "windows": windows }))
    }

    fn list_apps<B: DesktopBackend>(&self, backend: &B) -> Result<Value> {
        let result = backend.invoke("list_apps", &json!({}))?;
        if result["status"] != "ok" {
            return Ok(result);
        }
        let apps = result["apps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|app| {
                let name = app
                    .get("name")
                    .or_else(|| app.get("displayName"))?
                    .as_str()?
                    .trim();
                if name.is_empty() {
                    return None;
                }
                let windows = app["windows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(canonical_window)
                    .collect::<Vec<_>>();
                Some(json!({
                    "app": name,
                    "windows": windows,
                    "isRunning": app["isRunning"].as_bool().unwrap_or(!windows.is_empty()),
                    "isFrontmost": app["isFrontmost"].as_bool().unwrap_or(false),
                    "path": app.get("path").cloned().unwrap_or(Value::Null),
                }))
            })
            .collect::<Vec<_>>();
        Ok(json!({ "status": "ok", "apps": apps }))
    }

    fn get_window<B: DesktopBackend>(&self, backend: &B, params: &Value) -> Result<Value> {
        let Some(window_id) = canonical_window_id(params) else {
            return Ok(stale_target("canonical window is required"));
        };
        let result = backend.invoke(
            "get_window",
            &json!({ "windowId": platform_window_id(window_id) }),
        )?;
        if result["status"] != "ok" {
            return Ok(result);
        }
        let Some(window) = canonical_window(&result["window"]) else {
            return Ok(stale_target("platform window could not be rehydrated"));
        };
        Ok(json!({ "status": "ok", "window": window }))
    }

    fn get_window_state<B: DesktopBackend>(
        &mut self,
        backend: &B,
        params: &Value,
    ) -> Result<Value> {
        let Some(window_id) = canonical_window_id(params) else {
            return Ok(stale_target("canonical window is required"));
        };
        let legacy = backend.invoke(
            "get_window_state",
            &json!({ "windowId": platform_window_id(window_id) }),
        )?;
        if legacy["status"] != "ok" {
            return Ok(legacy);
        }
        self.canonical_state(
            legacy,
            params.get("include_text").and_then(Value::as_bool) != Some(false),
        )
    }

    fn canonical_state(&mut self, legacy: Value, include_text: bool) -> Result<Value> {
        let Some(window) = canonical_window(&legacy["window"]) else {
            return Ok(stale_target("platform state has no canonical window"));
        };
        let window_id = window["id"].as_u64().unwrap_or_default();
        let origin = bounds_origin(&legacy["window"]);
        let mut index_to_platform_id = HashMap::new();
        let mut platform_id_to_index = HashMap::new();
        let mut fingerprints = HashMap::new();
        let mut next_index = 0_u64;
        let tree = canonical_elements(
            legacy["accessibility"]["tree"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            origin,
            &mut next_index,
            &mut index_to_platform_id,
            &mut platform_id_to_index,
            &mut fingerprints,
        );
        let state_id = unique_id("state", window_id);
        self.states.insert(
            state_id.clone(),
            ElementSnapshot {
                window_id,
                index_to_platform_id,
                fingerprints,
            },
        );
        if self.states.len() > MAX_STATE_SNAPSHOTS {
            if let Some(oldest) = self.states.keys().min().cloned() {
                self.states.remove(&oldest);
            }
        }
        let focused_element = canonical_focused_element(
            &legacy["accessibility"]["focusedElement"],
            origin,
            &platform_id_to_index,
        );
        let mut accessibility = json!({
            "tree": tree,
            "selected_elements": [],
        });
        if let Some(focused) = focused_element {
            accessibility["focused_element"] = focused;
        }
        if include_text {
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
            copy_nonempty_string(
                &mut accessibility,
                "visible_text",
                &legacy["accessibility"]["visibleText"],
            );
        }
        if let Some(truncated) = legacy["accessibility"]["truncated"].as_bool() {
            accessibility["truncated"] = Value::Bool(truncated);
        }
        let mut state = json!({
            "status": "ok",
            "stateId": state_id,
            "window": window,
            "focused": legacy["window"]["focused"].as_bool().unwrap_or(false),
            "capturedAt": legacy["capturedAt"].as_u64().unwrap_or_else(now_millis),
            "accessibility": accessibility,
        });
        copy_field(&mut state, "textSource", &legacy, "textSource");
        copy_field(&mut state, "completeness", &legacy, "completeness");
        copy_field(&mut state, "fallbackReason", &legacy, "fallbackReason");
        Ok(state)
    }

    fn take_screenshot<B: DesktopBackend>(&mut self, backend: &B, params: &Value) -> Result<Value> {
        let Some(window_id) = canonical_window_id(params) else {
            return Ok(stale_target("canonical window is required"));
        };
        let legacy = backend.invoke(
            "get_window_state",
            &json!({ "windowId": platform_window_id(window_id), "includeScreenshot": true }),
        )?;
        if legacy["status"] != "ok" {
            return Ok(legacy);
        }
        let Some(window) = canonical_window(&legacy["window"]) else {
            return Ok(stale_target("platform screenshot has no canonical window"));
        };
        let Some(mut screenshots) = legacy["screenshots"].as_array().cloned() else {
            return Ok(json!({ "status": "failed", "message": "screenshot pixels unavailable" }));
        };
        screenshots.truncate(1);
        let pixel_region =
            match screenshot_pixel_region(params, &legacy["window"], screenshots.first()) {
                Ok(region) => region,
                Err(result) => return Ok(result),
            };
        let screenshot_id = unique_id("screenshot", window_id);
        if let Some(previous) = self
            .latest_screenshot_by_window
            .insert(window_id, screenshot_id.clone())
        {
            self.screenshots.remove(&previous);
        }
        self.screenshots.insert(screenshot_id.clone(), window_id);
        if let Some(primary) = screenshots.first_mut() {
            primary["id"] = Value::String(screenshot_id);
        }
        let mut result = json!({
            "status": "ok",
            "window": window,
            "capturedAt": now_millis(),
            "screenshots": screenshots,
            "region": params.get("region").cloned().unwrap_or(Value::Null),
        });
        if let Some(pixel_region) = pixel_region {
            result["pixelRegion"] = pixel_region;
        }
        Ok(result)
    }

    fn dispatch<B: DesktopBackend>(
        &mut self,
        backend: &B,
        method: &str,
        params: &Value,
    ) -> Result<Value> {
        let Some(window_id) = canonical_window_id(params) else {
            return Ok(stale_target("canonical window is required"));
        };
        if let Some(screenshot_id) = params.get("screenshotId").and_then(Value::as_str) {
            if self.screenshots.get(screenshot_id) != Some(&window_id)
                || self
                    .latest_screenshot_by_window
                    .get(&window_id)
                    .map(String::as_str)
                    != Some(screenshot_id)
            {
                return Ok(stale_target(
                    "screenshot does not belong to the current window",
                ));
            }
        }
        let mut legacy = params.as_object().cloned().unwrap_or_default();
        legacy.remove("window");
        legacy.remove("stateId");
        legacy.remove("screenshotId");
        legacy.insert(
            "windowId".to_owned(),
            Value::String(platform_window_id(window_id)),
        );

        let window_result = backend.invoke(
            "get_window",
            &json!({ "windowId": platform_window_id(window_id) }),
        )?;
        if window_result["status"] != "ok"
            || !window_matches(&window_result["window"], &params["window"])
        {
            return Ok(stale_target("window identity changed before dispatch"));
        }

        if let Some(index) = params.get("element_index").and_then(Value::as_u64) {
            let Some(state_id) = params.get("stateId").and_then(Value::as_str) else {
                return Ok(stale_target("stateId is required with element_index"));
            };
            let Some(snapshot) = self.states.get(state_id) else {
                return Ok(stale_target("element_index snapshot expired"));
            };
            if snapshot.window_id != window_id {
                return Ok(stale_target("element_index belongs to another window"));
            }
            let Some(platform_id) = snapshot.index_to_platform_id.get(&index) else {
                return Ok(stale_target("element_index is not present in the snapshot"));
            };
            let Some(expected_fingerprint) = snapshot.fingerprints.get(&index) else {
                return Ok(stale_target("element fingerprint is unavailable"));
            };
            let current_state = backend.invoke(
                "get_window_state",
                &json!({ "windowId": platform_window_id(window_id) }),
            )?;
            let Some(current_element) = find_platform_element(
                current_state["accessibility"]["tree"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                platform_id,
            ) else {
                return Ok(stale_target("element changed before dispatch"));
            };
            if element_fingerprint(current_element) != *expected_fingerprint {
                return Ok(stale_target("element changed before dispatch"));
            }
            legacy.remove("element_index");
            legacy.insert("elementId".to_owned(), Value::String(platform_id.clone()));
        }

        if has_coordinates(&legacy) {
            let (origin_x, origin_y) = bounds_origin(&window_result["window"]);
            offset_coordinate(&mut legacy, "x", origin_x);
            offset_coordinate(&mut legacy, "y", origin_y);
            offset_coordinate(&mut legacy, "fromX", origin_x);
            offset_coordinate(&mut legacy, "fromY", origin_y);
            offset_coordinate(&mut legacy, "toX", origin_x);
            offset_coordinate(&mut legacy, "toY", origin_y);
        }
        backend.invoke(method, &Value::Object(legacy))
    }
}

fn canonical_window(value: &Value) -> Option<Value> {
    let id = platform_numeric_window_id(value.get("id")?.as_str()?)?;
    let app = value
        .get("appName")
        .or_else(|| value.get("app"))?
        .as_str()?
        .trim();
    if app.is_empty() {
        return None;
    }
    let mut window = json!({ "id": id, "app": app });
    if let Some(title) = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
    {
        window["title"] = Value::String(title.to_owned());
    }
    Some(window)
}

fn canonical_window_id(params: &Value) -> Option<u64> {
    params
        .get("window")?
        .get("id")?
        .as_u64()
        .filter(|id| *id > 0)
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

fn canonical_elements(
    elements: &[Value],
    origin: (i64, i64),
    next_index: &mut u64,
    index_to_platform_id: &mut HashMap<u64, String>,
    platform_id_to_index: &mut HashMap<String, u64>,
    fingerprints: &mut HashMap<u64, ElementFingerprint>,
) -> Vec<Value> {
    elements
        .iter()
        .map(|element| {
            let index = *next_index;
            *next_index += 1;
            if let Some(id) = element.get("id").and_then(Value::as_str) {
                index_to_platform_id.insert(index, id.to_owned());
                platform_id_to_index.insert(id.to_owned(), index);
                fingerprints.insert(index, element_fingerprint(element));
            }
            let mut output = canonical_element_fields(element, index, origin);
            let children = canonical_elements(
                element
                    .get("children")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                origin,
                next_index,
                index_to_platform_id,
                platform_id_to_index,
                fingerprints,
            );
            if !children.is_empty() {
                output["children"] = Value::Array(children);
            }
            output
        })
        .collect()
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

fn element_fingerprint(element: &Value) -> ElementFingerprint {
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
        name: if element.get("sensitive").and_then(Value::as_bool) == Some(true) {
            String::new()
        } else {
            element
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        },
        sensitive: element
            .get("sensitive")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn canonical_focused_element(
    element: &Value,
    origin: (i64, i64),
    indices: &HashMap<String, u64>,
) -> Option<Value> {
    let id = element.get("id")?.as_str()?;
    let index = *indices.get(id)?;
    Some(canonical_element_fields(element, index, origin))
}

fn canonical_element_fields(element: &Value, index: u64, origin: (i64, i64)) -> Value {
    let mut output = json!({
        "element_index": index,
        "role": element.get("role").and_then(Value::as_str).unwrap_or("unknown"),
    });
    for key in [
        "name",
        "value",
        "enabled",
        "focused",
        "sensitive",
        "actions",
    ] {
        if let Some(value) = element.get(key).filter(|value| !value.is_null()) {
            output[key] = value.clone();
        }
    }
    if let Some(bounds) = relative_bounds(element.get("bounds"), origin) {
        output["bounds"] = bounds;
    }
    if element.get("settable").and_then(Value::as_bool) == Some(true)
        || element.get("role").and_then(Value::as_str) == Some("edit")
    {
        output["editable"] = Value::Bool(true);
    }
    output
}

fn relative_bounds(value: Option<&Value>, origin: (i64, i64)) -> Option<Value> {
    let bounds = value?.as_object()?;
    Some(json!({
        "x": bounds.get("x")?.as_i64()? - origin.0,
        "y": bounds.get("y")?.as_i64()? - origin.1,
        "width": bounds.get("width")?.as_i64()?,
        "height": bounds.get("height")?.as_i64()?,
    }))
}

fn bounds_origin(window: &Value) -> (i64, i64) {
    (
        window["bounds"]["x"].as_i64().unwrap_or_default(),
        window["bounds"]["y"].as_i64().unwrap_or_default(),
    )
}

fn screenshot_pixel_region(
    params: &Value,
    platform_window: &Value,
    screenshot: Option<&Value>,
) -> std::result::Result<Option<Value>, Value> {
    let Some(region) = params.get("region") else {
        return Ok(None);
    };
    let Some(region) = region.as_object() else {
        return Err(json!({ "status": "failed", "message": "screenshot region is invalid" }));
    };
    let number = |key: &str| {
        region
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
    };
    let (Some(x), Some(y), Some(width), Some(height)) =
        (number("x"), number("y"), number("width"), number("height"))
    else {
        return Err(json!({ "status": "failed", "message": "screenshot region is invalid" }));
    };
    let window_width = platform_window["bounds"]["width"]
        .as_f64()
        .unwrap_or_default();
    let window_height = platform_window["bounds"]["height"]
        .as_f64()
        .unwrap_or_default();
    if x < 0.0
        || y < 0.0
        || width <= 0.0
        || height <= 0.0
        || x + width > window_width
        || y + height > window_height
    {
        return Err(
            json!({ "status": "failed", "message": "screenshot region is outside window bounds" }),
        );
    }
    let Some(screenshot) = screenshot else {
        return Err(json!({ "status": "failed", "message": "screenshot pixels unavailable" }));
    };
    let pixel_width = screenshot["width"].as_f64().unwrap_or_default();
    let pixel_height = screenshot["height"].as_f64().unwrap_or_default();
    if window_width <= 0.0 || window_height <= 0.0 || pixel_width <= 0.0 || pixel_height <= 0.0 {
        return Err(json!({ "status": "failed", "message": "screenshot dimensions are invalid" }));
    }
    let left = (x * pixel_width / window_width).floor().max(0.0);
    let top = (y * pixel_height / window_height).floor().max(0.0);
    let right = ((x + width) * pixel_width / window_width)
        .ceil()
        .min(pixel_width);
    let bottom = ((y + height) * pixel_height / window_height)
        .ceil()
        .min(pixel_height);
    Ok(Some(json!({
        "x": left as u64,
        "y": top as u64,
        "width": (right - left).max(1.0) as u64,
        "height": (bottom - top).max(1.0) as u64,
    })))
}

fn has_coordinates(params: &Map<String, Value>) -> bool {
    ["x", "y", "fromX", "fromY", "toX", "toY"]
        .iter()
        .any(|key| params.get(*key).and_then(Value::as_f64).is_some())
}

fn offset_coordinate(params: &mut Map<String, Value>, key: &str, offset: i64) {
    if let Some(value) = params.get(key).and_then(Value::as_i64) {
        params.insert(key.to_owned(), json!(value + offset));
        return;
    }
    if let Some(value) = params.get(key).and_then(Value::as_f64) {
        params.insert(key.to_owned(), json!(value + offset as f64));
    }
}

fn copy_nonempty_string(output: &mut Value, key: &str, value: &Value) {
    if let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) {
        output[key] = Value::String(text.to_owned());
    }
}

fn copy_field(output: &mut Value, target: &str, source: &Value, source_key: &str) {
    if let Some(value) = source.get(source_key).filter(|value| !value.is_null()) {
        output[target] = value.clone();
    }
}

fn stale_target(message: &str) -> Value {
    json!({ "status": "stale_target", "message": message })
}

fn unique_id(kind: &str, window_id: u64) -> String {
    format!(
        "{kind}:{window_id}:{}:{}",
        now_millis(),
        NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed),
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
