use std::{
    collections::{BTreeMap, HashSet},
    ffi::c_void,
    mem::size_of,
    path::Path,
    process::Command,
    thread,
    time::Duration,
};

use crate::windows_capture::capture_window_bgra;
use crate::windows_cursor_motion::spring_close_enough_time_seconds;
use crate::windows_overlay::{
    move_visual_cursor, pulse_visual_cursor, settle_visual_cursor, VISUAL_CURSOR_WINDOW_TITLE,
};
use crate::{desktop_click_options, desktop_drag_points, DesktopBackend, DesktopMouseButton};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use windows::{
    core::{Interface, BOOL, BSTR, PWSTR},
    Win32::{
        Foundation::{
            CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HWND, LPARAM, POINT, RECT,
        },
        Graphics::Imaging::{
            CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat24bppBGR,
            IWICBitmapFrameEncode, IWICImagingFactory, WICBitmapEncoderNoCache,
        },
        Storage::Packaging::Appx::GetApplicationUserModelId,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, IStream, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED, STREAM_SEEK_CUR,
            },
            Threading::{
                AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
                PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation, ExpandCollapseState, ExpandCollapseState_Collapsed,
                ExpandCollapseState_Expanded, ExpandCollapseState_LeafNode,
                ExpandCollapseState_PartiallyExpanded, IUIAutomation, IUIAutomationElement,
                IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
                IUIAutomationScrollItemPattern, IUIAutomationSelectionItemPattern,
                IUIAutomationTextPattern, IUIAutomationTogglePattern, IUIAutomationTreeWalker,
                IUIAutomationValuePattern, UIA_ButtonControlTypeId, UIA_DocumentControlTypeId,
                UIA_EditControlTypeId, UIA_ExpandCollapsePatternId, UIA_GroupControlTypeId,
                UIA_InvokePatternId, UIA_ListControlTypeId, UIA_ListItemControlTypeId,
                UIA_MenuItemControlTypeId, UIA_PaneControlTypeId, UIA_ScrollItemPatternId,
                UIA_SelectionItemPatternId, UIA_TabItemControlTypeId, UIA_TextControlTypeId,
                UIA_TextPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
                UIA_WindowControlTypeId, UIA_CONTROLTYPE_ID,
            },
            HiDpi::GetDpiForWindow,
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
                KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
                MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
                MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
                MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
                VIRTUAL_KEY, VK_ADD, VK_BACK, VK_CONTROL, VK_DECIMAL, VK_DELETE, VK_DIVIDE,
                VK_DOWN, VK_END, VK_ESCAPE, VK_HOME, VK_LCONTROL, VK_LEFT, VK_LMENU, VK_LSHIFT,
                VK_LWIN, VK_MENU, VK_MULTIPLY, VK_NEXT, VK_NUMPAD0, VK_NUMPAD1, VK_NUMPAD2,
                VK_NUMPAD3, VK_NUMPAD4, VK_NUMPAD5, VK_NUMPAD6, VK_NUMPAD7, VK_NUMPAD8, VK_NUMPAD9,
                VK_OEM_1, VK_OEM_2, VK_OEM_3, VK_OEM_4, VK_OEM_5, VK_OEM_6, VK_OEM_7, VK_OEM_COMMA,
                VK_OEM_MINUS, VK_OEM_PERIOD, VK_OEM_PLUS, VK_PRIOR, VK_RCONTROL, VK_RETURN,
                VK_RIGHT, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SEPARATOR, VK_SHIFT, VK_SPACE,
                VK_SUBTRACT, VK_TAB, VK_UP,
            },
            WindowsAndMessaging::{
                BringWindowToTop, EnumWindows, GetForegroundWindow, GetSystemMetrics,
                GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
                IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow, ShowWindow,
                SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
                SW_RESTORE,
            },
        },
    },
};

pub struct WindowsDesktopBackend;

impl DesktopBackend for WindowsDesktopBackend {
    fn invoke(&self, method: &str, params: &Value) -> Result<Value> {
        if is_action(method) {
            if let Some(result) = validate_action_target(params)? {
                return Ok(result);
            }
        }
        match method {
            "list_windows" => list_windows(params),
            "list_apps" => list_apps(),
            "get_window" => get_window(params),
            "get_window_state" => get_window_state(params),
            "preflight_action" => preflight_action(params),
            "current_context" => current_context(params),
            "launch_app" => launch_app(params),
            "activate_window" => with_window(params, |hwnd| activate(hwnd)),
            "move_pointer" => move_pointer(params),
            "click" => click(params),
            "perform_secondary_action" => perform_secondary_action(params),
            "scroll" => scroll(params),
            "drag" => drag(params),
            "press_key" => press_key(params),
            "type_text" => type_text(params),
            "set_value" => set_value(params),
            "search_context" => Ok(json!({
                "status": "unavailable",
                "message": "desktop context search is provided by the Lume sidecar"
            })),
            _ => Ok(
                json!({ "status": "failed", "message": format!("unsupported method: {method}") }),
            ),
        }
    }
}

fn sensitive_text_target(params: &Value) -> Result<bool> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let element = if params.get("elementId").is_some() {
            resolve_element(params)?
        } else {
            automation.GetFocusedElement().ok()
        };
        Ok(element
            .and_then(|item| item.CurrentIsPassword().ok())
            .map(|value| value.as_bool())
            .unwrap_or(false))
    }
}

fn list_windows(params: &Value) -> Result<Value> {
    let app_filter = params.get("appId").and_then(Value::as_str);
    let windows = enumerate_windows()?
        .into_iter()
        .filter_map(|hwnd| window_json(hwnd))
        .filter(|window| app_filter.is_none_or(|app_id| window["appId"] == app_id))
        .collect::<Vec<_>>();
    Ok(json!({ "status": "ok", "windows": windows }))
}

fn list_apps() -> Result<Value> {
    let mut apps = BTreeMap::<String, Value>::new();
    let mut running_names = HashSet::<String>::new();
    for hwnd in enumerate_windows()? {
        if let Some(window) = window_json(hwnd) {
            let app_id = window["appId"].as_str().unwrap_or_default().to_owned();
            running_names.insert(normalized_app_name(
                window["appName"].as_str().unwrap_or_default(),
            ));
            let app = apps.entry(app_id.to_ascii_lowercase()).or_insert_with(|| {
                json!({
                    "id": app_id,
                    "name": window["appName"],
                    "displayName": window["appName"],
                    "processId": window["processId"],
                    "platformId": window["platformId"],
                    "isRunning": true,
                    "isFrontmost": window["focused"],
                    "windows": [],
                })
            });
            if window["focused"] == true {
                app["isFrontmost"] = json!(true);
            }
            app["windows"]
                .as_array_mut()
                .expect("app windows is initialized as an array")
                .push(window);
        }
    }
    for discovered in discover_start_apps() {
        let key = discovered.id.to_ascii_lowercase();
        if let Some(app) = apps.get_mut(&key) {
            app["name"] = Value::String(discovered.name.clone());
            app["displayName"] = Value::String(discovered.name);
            continue;
        }
        if running_names.contains(&normalized_app_name(&discovered.name)) {
            continue;
        }
        let id = discovered.id;
        let name = discovered.name;
        apps.entry(key).or_insert_with(|| {
            json!({
                "id": id,
                "name": name,
                "displayName": name,
                "path": format!("shell:AppsFolder\\{}", id),
                "isRunning": false,
                "isFrontmost": false,
                "windows": [],
            })
        });
    }
    let mut values = apps.into_values().collect::<Vec<_>>();
    values.sort_by(compare_windows_apps);
    Ok(json!({ "status": "ok", "apps": values }))
}

#[derive(Debug, PartialEq)]
struct WindowsDiscoveredApp {
    id: String,
    name: String,
}

fn discover_start_apps() -> Vec<WindowsDiscoveredApp> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_start_apps_json(&String::from_utf8_lossy(&output.stdout))
}

fn parse_start_apps_json(input: &str) -> Vec<WindowsDiscoveredApp> {
    let Ok(value) = serde_json::from_str::<Value>(input) else {
        return Vec::new();
    };
    let candidates = match value {
        Value::Array(values) => values,
        Value::Object(_) => vec![value],
        _ => return Vec::new(),
    };
    let mut seen = HashSet::<String>::new();
    candidates
        .into_iter()
        .filter_map(|candidate| {
            let id = candidate.get("AppID")?.as_str()?.trim();
            let name = candidate.get("Name")?.as_str()?.trim();
            if id.is_empty() || name.is_empty() || !seen.insert(id.to_ascii_lowercase()) {
                return None;
            }
            Some(WindowsDiscoveredApp {
                id: id.to_owned(),
                name: name.to_owned(),
            })
        })
        .collect()
}

fn normalized_app_name(name: &str) -> String {
    name.trim()
        .strip_suffix(".exe")
        .unwrap_or(name.trim())
        .to_ascii_lowercase()
}

fn compare_windows_apps(left: &Value, right: &Value) -> std::cmp::Ordering {
    right["isFrontmost"]
        .as_bool()
        .unwrap_or(false)
        .cmp(&left["isFrontmost"].as_bool().unwrap_or(false))
        .then_with(|| {
            right["isRunning"]
                .as_bool()
                .unwrap_or(false)
                .cmp(&left["isRunning"].as_bool().unwrap_or(false))
        })
        .then_with(|| {
            left["name"]
                .as_str()
                .unwrap_or_default()
                .to_ascii_lowercase()
                .cmp(
                    &right["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_ascii_lowercase(),
                )
        })
}

#[cfg(test)]
mod app_discovery_tests {
    use super::{compare_windows_apps, parse_start_apps_json};
    use serde_json::json;

    #[test]
    fn parses_start_apps_and_deduplicates_ids() {
        let apps = parse_start_apps_json(
            r#"[{"Name":"微信","AppID":"Tencent.WeChat"},{"Name":"微信","AppID":"tencent.wechat"},{"Name":"","AppID":"missing.name"},{"Name":"Broken","AppID":""}]"#,
        );

        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].id, "Tencent.WeChat");
        assert_eq!(apps[0].name, "微信");
    }

    #[test]
    fn sorts_frontmost_then_running_then_installed_apps() {
        let mut apps = vec![
            json!({ "name": "Calculator", "isRunning": false, "isFrontmost": false }),
            json!({ "name": "Word", "isRunning": true, "isFrontmost": false }),
            json!({ "name": "WeChat", "isRunning": true, "isFrontmost": true }),
        ];

        apps.sort_by(compare_windows_apps);

        assert_eq!(apps[0]["name"], "WeChat");
        assert_eq!(apps[1]["name"], "Word");
        assert_eq!(apps[2]["name"], "Calculator");
    }
}

fn get_window(params: &Value) -> Result<Value> {
    let hwnd = target_window(params).unwrap_or_else(|| unsafe { GetForegroundWindow() });
    let Some(window) = window_json(hwnd) else {
        return Ok(stale_target());
    };
    Ok(json!({ "status": "ok", "window": window }))
}

fn get_window_state(params: &Value) -> Result<Value> {
    let hwnd = target_window(params).unwrap_or_else(|| unsafe { GetForegroundWindow() });
    let Some(window) = window_json(hwnd) else {
        return Ok(stale_target());
    };
    let title = window["title"].as_str().unwrap_or_default();
    let screenshots = screenshot_refs(
        hwnd,
        &window,
        params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
    )?;
    let accessibility = if params.get("includeText").and_then(Value::as_bool) == Some(false) {
        Value::Null
    } else {
        accessibility_state(hwnd)
            .unwrap_or_else(|error| fallback_accessibility_state(title, Some(error.to_string())))
    };
    let quality = context_quality(&accessibility, title);
    let mut state = json!({
        "status": "ok",
        "window": window,
        "capturedAt": now_millis(),
        "screenshots": screenshots,
        "accessibility": accessibility,
        "textSource": quality.source,
        "completeness": quality.completeness,
    });
    if let Some(reason) = quality.fallback_reason {
        state["fallbackReason"] = Value::String(reason);
    }
    Ok(state)
}

fn is_action(method: &str) -> bool {
    matches!(
        method,
        "activate_window"
            | "move_pointer"
            | "click"
            | "perform_secondary_action"
            | "scroll"
            | "drag"
            | "press_key"
            | "type_text"
            | "set_value"
    )
}

fn validate_action_target(params: &Value) -> Result<Option<Value>> {
    if params.get("elementId").is_some() && resolve_element_bounds(params)?.is_none() {
        return Ok(Some(stale_target()));
    }
    Ok(None)
}

fn current_context(params: &Value) -> Result<Value> {
    let hwnd = unsafe { GetForegroundWindow() };
    let Some(window) = window_json(hwnd) else {
        return Ok(stale_target());
    };
    let accessibility = accessibility_state(hwnd).unwrap_or_else(|error| {
        fallback_accessibility_state(
            window["title"].as_str().unwrap_or_default(),
            Some(error.to_string()),
        )
    });
    let screenshots = screenshot_refs(
        hwnd,
        &window,
        params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
    )?;
    let quality = context_quality(&accessibility, window["title"].as_str().unwrap_or_default());
    let selected_text = accessibility
        .get("selectedText")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty());
    let mut snapshot = json!({
        "id": format!("foreground:{}", now_millis()),
        "app": {
            "id": window["appId"],
            "name": window["appName"],
            "processId": window["processId"],
        },
        "window": window,
        "capturedAt": now_millis(),
        "eventType": "foreground_changed",
        "visibleText": quality.text,
        "textSource": quality.source,
        "completeness": quality.completeness,
        "screenshotId": screenshot_id(&window),
        "screenshots": screenshots,
        "untrusted": true,
    });
    if let Some(selected_text) = selected_text {
        snapshot["selectedText"] = Value::String(selected_text.to_owned());
    }
    if let Some(reason) = quality.fallback_reason {
        snapshot["fallbackReason"] = Value::String(reason);
    }
    Ok(json!({
        "status": "ok",
        "snapshot": snapshot,
    }))
}

struct ContextTextSelection {
    text: String,
    source: &'static str,
    completeness: &'static str,
    fallback_reason: Option<String>,
}

fn context_quality(accessibility: &Value, window_title: &str) -> ContextTextSelection {
    let selected_text = accessibility
        .get("selectedText")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let document_text = accessibility
        .get("documentText")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let visible_text = accessibility
        .get("visibleText")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let truncated = accessibility
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let unavailable_reason = accessibility
        .get("unavailableReason")
        .and_then(Value::as_str);
    let mut selection = select_context_text(
        window_title,
        document_text,
        visible_text,
        truncated,
        unavailable_reason,
    );
    if !selected_text.is_empty() {
        selection.source = "accessibility_selection";
        selection.completeness = if truncated { "partial" } else { "complete" };
        selection.fallback_reason = None;
    }
    selection
}

fn select_context_text(
    window_title: &str,
    document_text: &str,
    visible_text: &str,
    truncated: bool,
    unavailable_reason: Option<&str>,
) -> ContextTextSelection {
    if let Some(reason) = unavailable_reason {
        return ContextTextSelection {
            text: window_title.trim().to_owned(),
            source: "window_title",
            completeness: "minimal",
            fallback_reason: Some(reason.to_owned()),
        };
    }
    let document_text = document_text.trim();
    if !document_text.is_empty() {
        return ContextTextSelection {
            text: document_text.to_owned(),
            source: "accessibility_document",
            completeness: if truncated { "partial" } else { "complete" },
            fallback_reason: unavailable_reason.map(str::to_owned),
        };
    }
    let visible_text = visible_text.trim();
    if !visible_text.is_empty() && visible_text != window_title.trim() {
        return ContextTextSelection {
            text: visible_text.to_owned(),
            source: "accessibility_visible",
            completeness: "partial",
            fallback_reason: Some("document text unavailable".to_owned()),
        };
    }
    ContextTextSelection {
        text: window_title.trim().to_owned(),
        source: "window_title",
        completeness: "minimal",
        fallback_reason: Some(
            unavailable_reason
                .unwrap_or("accessibility text unavailable")
                .to_owned(),
        ),
    }
}

fn screenshot_refs(hwnd: HWND, window: &Value, include_pixels: bool) -> Result<Vec<Value>> {
    let width = window["bounds"]["width"]
        .as_i64()
        .unwrap_or_default()
        .max(0) as i32;
    let height = window["bounds"]["height"]
        .as_i64()
        .unwrap_or_default()
        .max(0) as i32;
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    let mut screenshots = vec![screenshot_ref(
        hwnd,
        screenshot_id(window),
        RECT {
            left: window["bounds"]["x"].as_i64().unwrap_or_default() as i32,
            top: window["bounds"]["y"].as_i64().unwrap_or_default() as i32,
            right: window["bounds"]["x"].as_i64().unwrap_or_default() as i32 + width,
            bottom: window["bounds"]["y"].as_i64().unwrap_or_default() as i32 + height,
        },
        include_pixels,
        0,
        (0, 0),
    )?];
    let target_left = window["bounds"]["x"].as_i64().unwrap_or_default() as i32;
    let target_top = window["bounds"]["y"].as_i64().unwrap_or_default() as i32;
    let target_dpi = window
        .get("dpi")
        .and_then(Value::as_u64)
        .unwrap_or(96)
        .max(1) as f64;
    let related = related_transient_windows(hwnd, 2);
    let related_count = related.len();
    screenshots.extend(
        related
            .into_iter()
            .enumerate()
            .map(|(index, (related, bounds))| {
                screenshot_ref(
                    related,
                    transient_screenshot_id(related, &bounds),
                    bounds,
                    include_pixels,
                    (related_count - index) as i64,
                    (
                        (f64::from(bounds.left - target_left) * 96.0 / target_dpi).round() as i32,
                        (f64::from(bounds.top - target_top) * 96.0 / target_dpi).round() as i32,
                    ),
                )
            })
            .collect::<Result<Vec<_>>>()?,
    );
    Ok(screenshots)
}

fn screenshot_ref(
    hwnd: HWND,
    id: String,
    bounds: RECT,
    include_pixels: bool,
    z_index: i64,
    origin: (i32, i32),
) -> Result<Value> {
    let width = (bounds.right - bounds.left).max(0);
    let height = (bounds.bottom - bounds.top).max(0);
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    let (logical_width, logical_height) = logical_capture_size(width as u32, height as u32, dpi);
    let mut screenshot = json!({
        "id": id,
        "width": logical_width,
        "height": logical_height,
        "origin": {
            "x": origin.0,
            "y": origin.1,
        },
        "mimeType": "image/png",
        "zIndex": z_index,
    });
    if include_pixels {
        let capture = capture_window_png_data_url(hwnd, width, height)?;
        screenshot["dataUrl"] = Value::String(capture.data_url);
        screenshot["captureMode"] = Value::String(capture.mode.to_owned());
        screenshot["width"] = json!(capture.width);
        screenshot["height"] = json!(capture.height);
        screenshot["physicalWidth"] = json!(capture.physical_width);
        screenshot["physicalHeight"] = json!(capture.physical_height);
        screenshot["captureLeft"] = json!(bounds.left);
        screenshot["captureTop"] = json!(bounds.top);
        screenshot["dpi"] = json!(dpi);
    }
    Ok(screenshot)
}

fn screenshot_id(window: &Value) -> String {
    format!(
        "screenshot:{}:{}",
        window["id"].as_str().unwrap_or_default(),
        now_millis()
    )
}

fn transient_screenshot_id(hwnd: HWND, bounds: &RECT) -> String {
    format!(
        "screenshot:{}:{}:{}:{}:{}",
        window_id(hwnd),
        bounds.left,
        bounds.top,
        bounds.right - bounds.left,
        bounds.bottom - bounds.top,
    )
}

struct RelatedWindowSearch {
    target: HWND,
    target_process_id: u32,
    target_bounds: RECT,
    reached_target: bool,
    limit: usize,
    windows: Vec<(HWND, RECT)>,
}

fn related_transient_windows(target: HWND, limit: usize) -> Vec<(HWND, RECT)> {
    let mut target_process_id = 0;
    unsafe {
        GetWindowThreadProcessId(target, Some(&mut target_process_id));
    }
    let mut target_bounds = RECT::default();
    if target_process_id == 0 || unsafe { GetWindowRect(target, &mut target_bounds) }.is_err() {
        return Vec::new();
    }
    let mut search = RelatedWindowSearch {
        target,
        target_process_id,
        target_bounds,
        reached_target: false,
        limit,
        windows: Vec::new(),
    };
    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut RelatedWindowSearch);
        if hwnd == search.target {
            search.reached_target = true;
            return BOOL(1);
        }
        if search.reached_target
            || search.windows.len() >= search.limit
            || !IsWindowVisible(hwnd).as_bool()
        {
            return BOOL(1);
        }
        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id != search.target_process_id {
            return BOOL(1);
        }
        let mut bounds = RECT::default();
        if GetWindowRect(hwnd, &mut bounds).is_ok()
            && bounds.right > bounds.left
            && bounds.bottom > bounds.top
            && rectangles_intersect(&bounds, &search.target_bounds)
        {
            search.windows.push((hwnd, bounds));
        }
        BOOL(1)
    }
    unsafe {
        let _ = EnumWindows(
            Some(callback),
            LPARAM((&mut search as *mut RelatedWindowSearch) as isize),
        );
    }
    search.windows
}

fn rectangles_intersect(left: &RECT, right: &RECT) -> bool {
    left.left < right.right
        && left.right > right.left
        && left.top < right.bottom
        && left.bottom > right.top
}

struct WindowCapture {
    data_url: String,
    mode: &'static str,
    width: u32,
    height: u32,
    physical_width: u32,
    physical_height: u32,
}

fn preflight_action(params: &Value) -> Result<Value> {
    let hwnd = target_window(params).ok_or_else(|| anyhow!("target window is unavailable"))?;
    let x = int_param(params, "x")?;
    let y = int_param(params, "y")?;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let element = automation.ElementFromPoint(POINT { x, y })?;
        let mut target_process_id = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut target_process_id));
        let element_process_id = element.CurrentProcessId().unwrap_or_default() as u32;
        if target_process_id != 0
            && element_process_id != 0
            && target_process_id != element_process_id
        {
            return Err(anyhow!("action target is no longer available"));
        }
        let sensitive = element
            .CurrentIsPassword()
            .map(|value| value.as_bool())
            .unwrap_or(false);
        let name = if sensitive {
            String::new()
        } else {
            element
                .CurrentName()
                .map(|value| value.to_string())
                .unwrap_or_default()
        };
        let role = element
            .CurrentControlType()
            .map(control_type_name)
            .unwrap_or("unknown");
        Ok(json!({
            "status": "ok",
            "name": name,
            "role": role,
            "sensitive": sensitive,
        }))
    }
}

fn capture_window_png_data_url(hwnd: HWND, _width: i32, _height: i32) -> Result<WindowCapture> {
    if unsafe { IsIconic(hwnd).as_bool() } {
        return Err(anyhow!(
            "target window is minimized; call activate_window, get_window, then get_window_state"
        ));
    }
    let capture = capture_window_bgra(hwnd, Duration::from_millis(1500))?;
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    let (width, height) = logical_capture_size(capture.width, capture.height, dpi);
    let pixels = scale_bgra_nearest(
        &capture.pixels,
        capture.width,
        capture.height,
        width,
        height,
    )?;
    Ok(WindowCapture {
        data_url: encode_bgra_png_data_url(&pixels, width, height)?,
        mode: "windows_graphics_capture",
        width,
        height,
        physical_width: capture.width,
        physical_height: capture.height,
    })
}

fn logical_capture_size(width: u32, height: u32, dpi: u32) -> (u32, u32) {
    let dpi = dpi.max(1) as u64;
    (
        ((u64::from(width) * 96 + dpi / 2) / dpi).max(1) as u32,
        ((u64::from(height) * 96 + dpi / 2) / dpi).max(1) as u32,
    )
}

fn scale_bgra_nearest(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> Result<Vec<u8>> {
    let expected = source_width as usize * source_height as usize * 4;
    if pixels.len() != expected || source_width == 0 || source_height == 0 {
        return Err(anyhow!("window capture returned an invalid pixel buffer"));
    }
    if source_width == target_width && source_height == target_height {
        return Ok(pixels.to_vec());
    }
    let mut output = vec![0_u8; target_width as usize * target_height as usize * 4];
    for y in 0..target_height {
        let source_y = u64::from(y) * u64::from(source_height) / u64::from(target_height);
        for x in 0..target_width {
            let source_x = u64::from(x) * u64::from(source_width) / u64::from(target_width);
            let source = ((source_y * u64::from(source_width) + source_x) * 4) as usize;
            let target = ((u64::from(y) * u64::from(target_width) + u64::from(x)) * 4) as usize;
            output[target..target + 4].copy_from_slice(&pixels[source..source + 4]);
        }
    }
    Ok(output)
}

fn encode_bgra_png_data_url(pixels: &[u8], width: u32, height: u32) -> Result<String> {
    let expected_bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixel_count| pixel_count.checked_mul(4))
        .ok_or_else(|| anyhow!("window capture dimensions are too large"))?;
    if pixels.len() != expected_bytes {
        return Err(anyhow!("window capture returned an invalid pixel buffer"));
    }
    let stride = width
        .checked_mul(3)
        .ok_or_else(|| anyhow!("window capture dimensions are too large"))?;
    let mut bgr = Vec::with_capacity(expected_bytes / 4 * 3);
    for pixel in pixels.chunks_exact(4) {
        bgr.extend_from_slice(&pixel[..3]);
    }
    let capacity = expected_bytes
        .checked_add(height as usize)
        .and_then(|size| size.checked_add(64 * 1024))
        .ok_or_else(|| anyhow!("window capture dimensions are too large"))?;
    let mut png = vec![0_u8; capacity];
    let written = unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let stream = factory.CreateStream()?;
        stream.InitializeFromMemory(&png)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;

        let mut frame: Option<IWICBitmapFrameEncode> = None;
        let mut options = None;
        encoder.CreateNewFrame(&mut frame, &mut options)?;
        let frame = frame.ok_or_else(|| anyhow!("PNG encoder did not create a frame"))?;
        frame.Initialize(options.as_ref())?;
        frame.SetSize(width, height)?;
        let mut pixel_format = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut pixel_format)?;
        frame.WritePixels(height, stride, &bgr)?;
        frame.Commit()?;
        encoder.Commit()?;

        let output: IStream = stream.cast()?;
        let mut position = 0_u64;
        output.Seek(0, STREAM_SEEK_CUR, Some(&mut position))?;
        position as usize
    };
    if written == 0 || written > png.len() {
        return Err(anyhow!("PNG encoder returned an invalid output size"));
    }
    png.truncate(written);
    Ok(format!("data:image/png;base64,{}", BASE64.encode(png)))
}

fn accessibility_state(hwnd: HWND) -> Result<Value> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let root = automation.ElementFromHandle(hwnd)?;
        let walker = automation.ControlViewWalker()?;
        let mut remaining = 500usize;
        let mut text = Vec::<String>::new();
        let mut document_text = None;
        let mut selected_text = None;
        let tree = collect_accessibility_children(
            &walker,
            &root,
            "root",
            0,
            &mut remaining,
            &mut text,
            &mut document_text,
            &mut selected_text,
        );
        let focused = find_focused_element(&tree);
        Ok(json!({
            "tree": tree,
            "focusedElement": focused,
            "selectedText": normalize_document_text(selected_text),
            "documentText": normalize_document_text(document_text),
            "visibleText": text.join("\n"),
            "truncated": remaining == 0,
        }))
    }
}

fn fallback_accessibility_state(document_text: &str, unavailable_reason: Option<String>) -> Value {
    let mut value = json!({
        "tree": [],
        "focusedElement": Value::Null,
        "selectedText": "",
        "documentText": document_text,
        "visibleText": document_text,
        "truncated": false,
    });
    if let Some(reason) = unavailable_reason {
        value["unavailableReason"] = Value::String(reason);
    }
    value
}

unsafe fn collect_accessibility_children(
    walker: &IUIAutomationTreeWalker,
    parent: &IUIAutomationElement,
    parent_path: &str,
    depth: usize,
    remaining: &mut usize,
    text: &mut Vec<String>,
    document_text: &mut Option<String>,
    selected_text: &mut Option<String>,
) -> Vec<Value> {
    if depth >= 14 || *remaining == 0 {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut child = unsafe { walker.GetFirstChildElement(parent) }.ok();
    let mut index = 0usize;
    while let Some(element) = child {
        if *remaining == 0 {
            break;
        }
        *remaining -= 1;
        let path = format!("{parent_path}.{index}");
        let name = unsafe { element.CurrentName() }
            .map(|value| value.to_string())
            .unwrap_or_default();
        let role = unsafe { element.CurrentControlType() }
            .map(control_type_name)
            .unwrap_or("unknown");
        let rect = unsafe { element.CurrentBoundingRectangle() }.unwrap_or_default();
        let focused = unsafe { element.CurrentHasKeyboardFocus() }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        let enabled = unsafe { element.CurrentIsEnabled() }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        let sensitive = unsafe { element.CurrentIsPassword() }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        let value = if sensitive {
            None
        } else {
            read_element_value(&element)
        };
        let actions = supported_secondary_actions(&element);
        if !name.trim().is_empty()
            && !sensitive
            && matches!(
                role,
                "text" | "document" | "edit" | "listitem" | "button" | "menuitem"
            )
        {
            text.push(name.clone());
        }
        if document_text.is_none() && !sensitive && matches!(role, "document" | "edit") {
            *document_text = read_document_text(&element);
        }
        if selected_text.is_none() && !sensitive && matches!(role, "document" | "edit") {
            *selected_text = read_selected_text(&element);
        }
        let children = unsafe {
            collect_accessibility_children(
                walker,
                &element,
                &path,
                depth + 1,
                remaining,
                text,
                document_text,
                selected_text,
            )
        };
        let mut node = json!({
            "id": path,
            "role": role,
            "name": if sensitive { "[SENSITIVE]" } else { name.as_str() },
            "bounds": {
                "x": rect.left,
                "y": rect.top,
                "width": rect.right - rect.left,
                "height": rect.bottom - rect.top,
            },
            "enabled": enabled,
            "focused": focused,
            "sensitive": sensitive,
            "children": children,
        });
        if !actions.is_empty() {
            node["actions"] = json!(actions);
        }
        if let Some(value) = value {
            node["value"] = Value::String(value);
        }
        result.push(node);
        index += 1;
        child = unsafe { walker.GetNextSiblingElement(&element) }.ok();
    }
    result
}

fn read_element_value(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let pattern = element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .ok()?;
        let value = pattern.CurrentValue().ok()?.to_string();
        Some(value)
    }
}

fn read_selected_text(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let pattern = element
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok()?;
        let ranges = pattern.GetSelection().ok()?;
        let length = ranges.Length().ok()?.clamp(0, 16);
        let mut chunks = Vec::new();
        for index in 0..length {
            let Ok(range) = ranges.GetElement(index) else {
                continue;
            };
            let Ok(text) = range.GetText(100_000) else {
                continue;
            };
            let text = text.to_string();
            if !text.trim().is_empty() {
                chunks.push(text);
            }
        }
        let selected = chunks.join("\n");
        (!selected.trim().is_empty()).then_some(selected)
    }
}

fn read_document_text(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let pattern = element
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok()?;
        let range = pattern.DocumentRange().ok()?;
        let text = range.GetText(100_000).ok()?.to_string();
        (!text.trim().is_empty()).then_some(text)
    }
}

fn normalize_document_text(text: Option<String>) -> String {
    text.filter(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

fn find_focused_element(tree: &[Value]) -> Value {
    for element in tree {
        if element.get("focused").and_then(Value::as_bool) == Some(true) {
            return element.clone();
        }
        if let Some(children) = element.get("children").and_then(Value::as_array) {
            let focused = find_focused_element(children);
            if !focused.is_null() {
                return focused;
            }
        }
    }
    Value::Null
}

fn control_type_name(value: UIA_CONTROLTYPE_ID) -> &'static str {
    if value == UIA_ButtonControlTypeId {
        "button"
    } else if value == UIA_EditControlTypeId {
        "edit"
    } else if value == UIA_TextControlTypeId {
        "text"
    } else if value == UIA_ListItemControlTypeId {
        "listitem"
    } else if value == UIA_ListControlTypeId {
        "list"
    } else if value == UIA_MenuItemControlTypeId {
        "menuitem"
    } else if value == UIA_WindowControlTypeId {
        "window"
    } else if value == UIA_PaneControlTypeId {
        "pane"
    } else if value == UIA_DocumentControlTypeId {
        "document"
    } else if value == UIA_GroupControlTypeId {
        "group"
    } else if value == UIA_TabItemControlTypeId {
        "tab"
    } else {
        "unknown"
    }
}

fn launch_app(params: &Value) -> Result<Value> {
    let command = params
        .get("path")
        .or_else(|| params.get("app"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if command.is_empty() {
        return Ok(json!({ "status": "failed", "message": "path or app is required" }));
    }
    if command.starts_with("shell:")
        || matches!(
            Path::new(command)
                .extension()
                .and_then(|value| value.to_str()),
            Some("lnk" | "url" | "appref-ms")
        )
    {
        Command::new("explorer.exe").arg(command).spawn()?;
    } else {
        match Command::new(command).spawn() {
            Ok(_) => {}
            Err(_) => {
                Command::new("explorer.exe")
                    .arg(format!("shell:AppsFolder\\{command}"))
                    .spawn()?;
            }
        }
    }
    Ok(json!({ "status": "ok", "message": format!("launched {}", Path::new(command).display()) }))
}

fn with_window(params: &Value, action: impl FnOnce(HWND) -> Result<()>) -> Result<Value> {
    let Some(hwnd) = target_window(params) else {
        return Ok(stale_target());
    };
    action(hwnd)?;
    Ok(json!({ "status": "ok" }))
}

fn activate(hwnd: HWND) -> Result<()> {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let current_thread = GetCurrentThreadId();
        let foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let target_thread = GetWindowThreadProcessId(hwnd, None);
        let attached_threads =
            activation_thread_ids(current_thread, foreground_thread, target_thread);
        for thread_id in &attached_threads {
            let _ = AttachThreadInput(current_thread, *thread_id, true);
        }

        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);

        for thread_id in attached_threads.iter().rev() {
            let _ = AttachThreadInput(current_thread, *thread_id, false);
        }
    }
    for _ in 0..10 {
        if unsafe { GetForegroundWindow() } == hwnd {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(anyhow!("unable to activate target window"))
}

fn activation_thread_ids(current: u32, foreground: u32, target: u32) -> Vec<u32> {
    let mut thread_ids = Vec::with_capacity(2);
    for thread_id in [foreground, target] {
        if thread_id != 0 && thread_id != current && !thread_ids.contains(&thread_id) {
            thread_ids.push(thread_id);
        }
    }
    thread_ids
}

fn action_window(params: &Value) -> Result<HWND> {
    let hwnd = target_window(params).ok_or_else(|| anyhow!("target window is unavailable"))?;
    activate(hwnd)?;
    Ok(hwnd)
}

fn send_inputs(inputs: &[INPUT], emergency_release: Option<INPUT>) -> Result<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) } as usize;
    if sent == inputs.len() {
        return Ok(());
    }
    if let Some(release) = emergency_release {
        unsafe {
            let _ = SendInput(&[release], size_of::<INPUT>() as i32);
        }
    }
    Err(anyhow!(
        "SendInput dispatched {sent} of {} events: {}",
        inputs.len(),
        std::io::Error::last_os_error()
    ))
}

fn send_inputs_with_releases(inputs: &[INPUT], releases: &[INPUT]) -> Result<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) } as usize;
    if sent == inputs.len() {
        return Ok(());
    }
    if !releases.is_empty() {
        unsafe {
            let _ = SendInput(releases, size_of::<INPUT>() as i32);
        }
    }
    Err(anyhow!(
        "SendInput dispatched {sent} of {} keyboard events: {}",
        inputs.len(),
        std::io::Error::last_os_error()
    ))
}

fn mouse_input(dx: i32, dy: i32, mouse_data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: mouse_data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn mouse_move_input(x: i32, y: i32) -> Result<INPUT> {
    let bounds = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    let (dx, dy) = virtual_desktop_absolute((x, y), bounds)?;
    Ok(mouse_input(
        dx,
        dy,
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    ))
}

fn virtual_desktop_absolute(point: (i32, i32), bounds: (i32, i32, i32, i32)) -> Result<(i32, i32)> {
    let (left, top, width, height) = bounds;
    if width <= 1 || height <= 1 {
        return Err(anyhow!("virtual desktop has invalid dimensions"));
    }
    let normalize = |value: i32, origin: i32, extent: i32| {
        ((i64::from(value - origin) * 65_535) / i64::from(extent - 1)).clamp(0, 65_535) as i32
    };
    Ok((
        normalize(point.0, left, width),
        normalize(point.1, top, height),
    ))
}

fn mouse_button_flags(button: DesktopMouseButton) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match button {
        DesktopMouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        DesktopMouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        DesktopMouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

fn key_input(key: VIRTUAL_KEY, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: if key_up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn unicode_input(unit: u16, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: KEYEVENTF_UNICODE
                    | if key_up {
                        KEYEVENTF_KEYUP
                    } else {
                        Default::default()
                    },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn keyboard_input_sequence(keys: &[VIRTUAL_KEY]) -> Vec<INPUT> {
    keys.iter()
        .map(|key| key_input(*key, false))
        .chain(keys.iter().rev().map(|key| key_input(*key, true)))
        .collect()
}

fn unicode_input_sequence(text: &str) -> Vec<INPUT> {
    text.encode_utf16()
        .flat_map(|unit| [unicode_input(unit, false), unicode_input(unit, true)])
        .collect()
}

fn move_pointer(params: &Value) -> Result<Value> {
    let target = action_window(params)?;
    let (x, y) = action_point(params)?;
    animate_visual_pointer(x, y, Some(target));
    send_inputs(&[mouse_move_input(x, y)?], None)?;
    Ok(json!({ "status": "ok", "inputMode": "send_input" }))
}

fn click(params: &Value) -> Result<Value> {
    let options = match desktop_click_options(params, false) {
        Ok(options) => options,
        Err(message) => return Ok(json!({ "status": "failed", "message": message })),
    };
    let target = action_window(params)?;
    let semantic = preferred_pointer_injection(params, options.button) == "uia";
    let point = action_point(params)?;
    animate_visual_pointer(point.0, point.1, Some(target));
    if semantic {
        if let Some(input_mode) = try_preferred_element_click(params, options.count)? {
            pulse_visual_cursor(point.0, point.1, Some(target));
            return Ok(json!({ "status": "ok", "inputMode": input_mode }));
        }
    }
    send_click(point, options)?;
    pulse_visual_cursor(point.0, point.1, Some(target));
    Ok(json!({ "status": "ok", "inputMode": "send_input" }))
}

fn send_click(point: (i32, i32), options: crate::DesktopClickOptions) -> Result<()> {
    let (down, up) = mouse_button_flags(options.button);
    let mut inputs = vec![mouse_move_input(point.0, point.1)?];
    for index in 0..options.count {
        inputs.push(mouse_input(0, 0, 0, down));
        inputs.push(mouse_input(0, 0, 0, up));
        if index + 1 < options.count {
            inputs.push(mouse_move_input(point.0, point.1)?);
        }
    }
    send_inputs(&inputs, Some(mouse_input(0, 0, 0, up)))
}

fn perform_secondary_action(params: &Value) -> Result<Value> {
    let _target = action_window(params)?;
    let Some(element_id) = params.get("elementId").and_then(Value::as_str) else {
        return Ok(failed_action("elementId is required"));
    };
    let Some(requested_action) = params
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|action| !action.is_empty())
    else {
        return Ok(failed_action("action is required"));
    };
    let Some(action) = normalized_secondary_action(requested_action) else {
        return Ok(invalid_secondary_action(requested_action, element_id));
    };
    if action == "SetFocus" && !focus_action_enabled() {
        return Ok(failed_action(
            "SetFocus is disabled by default to avoid stealing user focus; set LUME_COMPUTER_USE_ALLOW_FOCUS_ACTIONS=1 to enable it.",
        ));
    }
    let Some(element) = resolve_element(params)? else {
        return Ok(json!({
            "status": "stale_target",
            "message": "target element is unavailable",
        }));
    };
    match invoke_secondary_action(&element, action) {
        Ok(true) => Ok(json!({ "status": "ok", "inputMode": "uia_action" })),
        Ok(false) => Ok(invalid_secondary_action(requested_action, element_id)),
        Err(error) => Ok(failed_action(&error.to_string())),
    }
}

fn scroll(params: &Value) -> Result<Value> {
    let hwnd = action_window(params)?;
    let point = action_point(params)?;
    settle_visual_cursor(point.0, point.1, Some(hwnd));
    let scroll_x = number_param(params, "scrollX")?.round() as i32;
    let scroll_y = number_param(params, "scrollY")?.round() as i32;
    let mut inputs = vec![mouse_move_input(point.0, point.1)?];
    if scroll_y != 0 {
        inputs.push(mouse_input(0, 0, (-scroll_y) as u32, MOUSEEVENTF_WHEEL));
    }
    if scroll_x != 0 {
        inputs.push(mouse_input(0, 0, scroll_x as u32, MOUSEEVENTF_HWHEEL));
    }
    send_inputs(&inputs, None)?;
    Ok(json!({ "status": "ok", "inputMode": "send_input" }))
}

fn drag(params: &Value) -> Result<Value> {
    let hwnd = action_window(params)?;
    let from_x = int_param(params, "fromX")?;
    let from_y = int_param(params, "fromY")?;
    let to_x = int_param(params, "toX")?;
    let to_y = int_param(params, "toY")?;
    send_drag((from_x, from_y), (to_x, to_y))?;
    pulse_visual_cursor(to_x, to_y, Some(hwnd));
    Ok(json!({ "status": "ok", "inputMode": "send_input" }))
}

fn send_drag(from: (i32, i32), to: (i32, i32)) -> Result<()> {
    let screen_points = desktop_drag_points(
        (i64::from(from.0), i64::from(from.1)),
        (i64::from(to.0), i64::from(to.1)),
        12,
    );
    let mut inputs = Vec::with_capacity(screen_points.len() + 3);
    inputs.push(mouse_move_input(from.0, from.1)?);
    inputs.push(mouse_input(0, 0, 0, MOUSEEVENTF_LEFTDOWN));
    for point in screen_points {
        inputs.push(mouse_move_input(point.0 as i32, point.1 as i32)?);
    }
    inputs.push(mouse_input(0, 0, 0, MOUSEEVENTF_LEFTUP));
    send_inputs(&inputs, Some(mouse_input(0, 0, 0, MOUSEEVENTF_LEFTUP)))
}

fn press_key(params: &Value) -> Result<Value> {
    let _hwnd = action_window(params)?;
    let key = params
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| anyhow!("key is required"))?;
    let virtual_keys = parse_key_chord(key)?;
    let inputs = keyboard_input_sequence(&virtual_keys);
    let releases = virtual_keys
        .iter()
        .rev()
        .map(|key| key_input(*key, true))
        .collect::<Vec<_>>();
    send_inputs_with_releases(&inputs, &releases)?;
    Ok(json!({ "status": "ok", "inputMode": "send_input" }))
}

fn type_text(params: &Value) -> Result<Value> {
    let _hwnd = action_window(params)?;
    if sensitive_text_target(params)? {
        return Ok(failed_action(
            "sensitive fields require a dedicated secure credential flow",
        ));
    }
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let inputs = unicode_input_sequence(text);
    let releases = text
        .encode_utf16()
        .map(|unit| unicode_input(unit, true))
        .collect::<Vec<_>>();
    send_inputs_with_releases(&inputs, &releases)?;
    Ok(json!({ "status": "ok", "inputMode": "send_input_unicode" }))
}

fn set_value(params: &Value) -> Result<Value> {
    let target = action_window(params)?;
    if sensitive_text_target(params)? {
        return Ok(failed_action(
            "sensitive fields require a dedicated secure credential flow",
        ));
    }
    if params.get("elementId").and_then(Value::as_str).is_none() {
        return Ok(failed_action("elementId is required"));
    }
    let (x, y) = action_point(params)?;
    animate_visual_pointer(x, y, Some(target));
    let value = params
        .get("value")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !try_set_element_value(params, value)? {
        return Ok(failed_action(
            "Cannot set a value for an element that is not settable",
        ));
    }
    pulse_visual_cursor(x, y, Some(target));
    Ok(json!({ "status": "ok", "inputMode": "uia_value" }))
}

fn action_point(params: &Value) -> Result<(i32, i32)> {
    if let Some(rect) = resolve_element_bounds(params)? {
        return Ok(((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2));
    }
    Ok((int_param(params, "x")?, int_param(params, "y")?))
}

fn resolve_element_bounds(params: &Value) -> Result<Option<RECT>> {
    Ok(resolve_element(params)?
        .and_then(|element| unsafe { element.CurrentBoundingRectangle().ok() }))
}

fn resolve_element(params: &Value) -> Result<Option<IUIAutomationElement>> {
    let Some(element_id) = params.get("elementId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(hwnd) = target_window(params) else {
        return Ok(None);
    };
    let Some(path) = element_id.strip_prefix("root") else {
        return Ok(None);
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let walker = automation.ControlViewWalker()?;
        let mut element = automation.ElementFromHandle(hwnd)?;
        for segment in path.split('.').filter(|part| !part.is_empty()) {
            let index = segment
                .parse::<usize>()
                .map_err(|_| anyhow!("invalid element id"))?;
            let mut child = walker.GetFirstChildElement(&element).ok();
            for _ in 0..index {
                child = child.and_then(|item| walker.GetNextSiblingElement(&item).ok());
            }
            let Some(next) = child else {
                return Ok(None);
            };
            element = next;
        }
        Ok(Some(element))
    }
}

fn enumerate_windows() -> Result<Vec<HWND>> {
    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
            let windows = &mut *(lparam.0 as *mut Vec<HWND>);
            windows.push(hwnd);
        }
        BOOL(1)
    }

    let mut windows = Vec::new();
    unsafe {
        EnumWindows(
            Some(callback),
            LPARAM((&mut windows as *mut Vec<HWND>) as isize),
        )?;
    }
    Ok(windows)
}

fn window_json(hwnd: HWND) -> Option<Value> {
    unsafe {
        if hwnd.0.is_null() || !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return None;
        }
        let mut title = vec![0_u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..copied.max(0) as usize]);
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        let mut process_id = 0_u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == std::process::id() && title == VISUAL_CURSOR_WINDOW_TITLE {
            return None;
        }
        let process_path = process_path(process_id);
        let app_name = process_path
            .as_deref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("process-{process_id}"));
        let app_id = process_application_user_model_id(process_id)
            .or(process_path)
            .unwrap_or_else(|| format!("process:{process_id}"));
        let foreground = GetForegroundWindow();
        Some(json!({
            "id": window_id(hwnd),
            "appId": app_id,
            "appName": app_name,
            "title": title,
            "bounds": {
                "x": rect.left,
                "y": rect.top,
                "width": rect.right - rect.left,
                "height": rect.bottom - rect.top,
            },
            "focused": foreground == hwnd,
            "minimized": IsIconic(hwnd).as_bool(),
            "dpi": GetDpiForWindow(hwnd).max(96),
            "processId": process_id,
            "platformId": format!("{}", hwnd.0 as usize),
        }))
    }
}

fn process_path(process_id: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut buffer = vec![0_u16; 32_768];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

fn process_application_user_model_id(process_id: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut length = 0_u32;
        let size_result = GetApplicationUserModelId(handle, &mut length, None);
        if size_result != ERROR_INSUFFICIENT_BUFFER || length <= 1 {
            let _ = CloseHandle(handle);
            return None;
        }
        let mut buffer = vec![0_u16; length as usize];
        let result =
            GetApplicationUserModelId(handle, &mut length, Some(PWSTR(buffer.as_mut_ptr())));
        let _ = CloseHandle(handle);
        if result != ERROR_SUCCESS || length <= 1 {
            return None;
        }
        Some(String::from_utf16_lossy(
            &buffer[..length.saturating_sub(1) as usize],
        ))
    }
}

fn target_window(params: &Value) -> Option<HWND> {
    let id = params.get("windowId").and_then(Value::as_str)?;
    let raw = id.strip_prefix("win:")?.parse::<usize>().ok()?;
    if raw == 0 {
        return None;
    }
    let hwnd = HWND(raw as *mut c_void);
    unsafe { IsWindow(Some(hwnd)).as_bool().then_some(hwnd) }
}

fn window_id(hwnd: HWND) -> String {
    format!("win:{}", hwnd.0 as usize)
}

fn animate_visual_pointer(x: i32, y: i32, target_window: Option<HWND>) {
    move_visual_cursor(x, y, target_window);
    thread::sleep(Duration::from_secs_f64(spring_close_enough_time_seconds()));
    settle_visual_cursor(x, y, target_window);
}

fn preferred_pointer_injection(params: &Value, button: DesktopMouseButton) -> &'static str {
    if button == DesktopMouseButton::Left
        && params.get("elementId").and_then(Value::as_str).is_some()
    {
        "uia"
    } else {
        "send_input"
    }
}

fn preferred_click_action_name(
    has_invoke: bool,
    has_selection: bool,
    has_toggle: bool,
) -> Option<&'static str> {
    if has_invoke {
        Some("Invoke")
    } else if has_selection {
        Some("Select")
    } else if has_toggle {
        Some("Toggle")
    } else {
        None
    }
}

fn try_preferred_element_click(params: &Value, click_count: u32) -> Result<Option<&'static str>> {
    let Some(element) = resolve_element(params)? else {
        return Ok(None);
    };
    let action = unsafe {
        preferred_click_action_name(
            element
                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .is_ok(),
            element
                .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
                .is_ok(),
            element
                .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                .is_ok(),
        )
    };
    let Some(action) = action else {
        return Ok(None);
    };
    let attempts = if action == "Invoke" { click_count } else { 1 };
    for _ in 0..attempts {
        if !invoke_secondary_action(&element, action)? {
            return Ok(None);
        }
    }
    Ok(Some(match action {
        "Invoke" => "uia_invoke",
        "Select" => "uia_select",
        "Toggle" => "uia_toggle",
        _ => unreachable!(),
    }))
}

fn supported_secondary_actions(element: &IUIAutomationElement) -> Vec<&'static str> {
    let mut actions = Vec::new();
    unsafe {
        if element
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .is_ok()
        {
            actions.push("Invoke");
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            .is_ok()
        {
            actions.push("Toggle");
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .is_ok()
        {
            actions.push("Select");
        }
        if let Ok(pattern) = element
            .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        {
            actions.extend_from_slice(expand_collapse_action_names(
                pattern.CurrentExpandCollapseState().ok(),
            ));
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
            .is_ok()
        {
            actions.push("ScrollIntoView");
        }
    }
    actions
}

fn expand_collapse_action_names(state: Option<ExpandCollapseState>) -> &'static [&'static str] {
    match state {
        Some(state) if state == ExpandCollapseState_Collapsed => &["Expand"],
        Some(state)
            if state == ExpandCollapseState_Expanded
                || state == ExpandCollapseState_PartiallyExpanded =>
        {
            &["Collapse"]
        }
        Some(state) if state == ExpandCollapseState_LeafNode => &[],
        _ => &["Expand", "Collapse"],
    }
}

fn normalized_secondary_action(action: &str) -> Option<&'static str> {
    match action.trim().to_ascii_lowercase().as_str() {
        "invoke" => Some("Invoke"),
        "toggle" => Some("Toggle"),
        "select" => Some("Select"),
        "expand" => Some("Expand"),
        "collapse" => Some("Collapse"),
        "scrollintoview" => Some("ScrollIntoView"),
        "setfocus" => Some("SetFocus"),
        _ => None,
    }
}

fn focus_action_enabled() -> bool {
    let lume = std::env::var("LUME_COMPUTER_USE_ALLOW_FOCUS_ACTIONS").ok();
    let compatible = std::env::var("OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS").ok();
    focus_action_enabled_from(lume.as_deref(), compatible.as_deref())
}

fn focus_action_enabled_from(lume: Option<&str>, compatible: Option<&str>) -> bool {
    lume.into_iter().chain(compatible).any(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn invoke_secondary_action(element: &IUIAutomationElement, action: &str) -> Result<bool> {
    unsafe {
        match action {
            "Invoke" => {
                let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                else {
                    return Ok(false);
                };
                pattern.Invoke()?;
            }
            "Toggle" => {
                let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                else {
                    return Ok(false);
                };
                pattern.Toggle()?;
            }
            "Select" => {
                let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                ) else {
                    return Ok(false);
                };
                pattern.Select()?;
            }
            "Expand" => {
                let Ok(pattern) = element
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                        UIA_ExpandCollapsePatternId,
                    )
                else {
                    return Ok(false);
                };
                pattern.Expand()?;
            }
            "Collapse" => {
                let Ok(pattern) = element
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                        UIA_ExpandCollapsePatternId,
                    )
                else {
                    return Ok(false);
                };
                pattern.Collapse()?;
            }
            "ScrollIntoView" => {
                let Ok(pattern) = element
                    .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
                else {
                    return Ok(false);
                };
                pattern.ScrollIntoView()?;
            }
            "SetFocus" => element.SetFocus()?,
            _ => return Ok(false),
        }
    }
    Ok(true)
}

fn try_set_element_value(params: &Value, value: &str) -> Result<bool> {
    let Some(element) = resolve_element(params)? else {
        return Ok(false);
    };
    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) };
    let Ok(pattern) = pattern else {
        return Ok(false);
    };
    if unsafe { pattern.CurrentIsReadOnly()? }.as_bool() {
        return Ok(false);
    }
    unsafe {
        pattern.SetValue(&BSTR::from(value))?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Imaging::{
        GUID_WICPixelFormat24bppBGR, WICDecodeMetadataCacheOnLoad,
    };

    #[test]
    fn png_encoder_preserves_bgra_pixel_boundaries() {
        let bgra = [
            0, 0, 255, 255, // red
            0, 255, 0, 255, // green
            255, 0, 0, 255, // blue
            255, 255, 255, 255, // white
        ];
        let data_url = encode_bgra_png_data_url(&bgra, 4, 1).unwrap();
        let mut png = BASE64
            .decode(data_url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();

        let decoded = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
            let stream = factory.CreateStream().unwrap();
            stream.InitializeFromMemory(&mut png).unwrap();
            let decoder = factory
                .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnLoad)
                .unwrap();
            let frame = decoder.GetFrame(0).unwrap();
            assert_eq!(frame.GetPixelFormat().unwrap(), GUID_WICPixelFormat24bppBGR);
            let mut pixels = vec![0_u8; 12];
            frame.CopyPixels(std::ptr::null(), 12, &mut pixels).unwrap();
            pixels
        };

        assert_eq!(
            decoded,
            [
                0, 0, 255, // red
                0, 255, 0, // green
                255, 0, 0, // blue
                255, 255, 255, // white
            ]
        );
    }

    #[test]
    fn prefers_windows_document_text_over_visible_nodes() {
        let result = select_context_text("项目群", "完整正文", "消息 A\n消息 B", false, None);

        assert_eq!(result.text, "完整正文");
        assert_eq!(result.source, "accessibility_document");
        assert_eq!(result.completeness, "complete");
    }

    #[test]
    fn treats_windows_selected_text_as_complete_semantic_context() {
        let result = context_quality(
            &json!({
                "selectedText": "这个 PR 今天能发吗？",
                "documentText": "",
                "visibleText": "微信",
                "truncated": false,
            }),
            "微信",
        );

        assert_eq!(result.source, "accessibility_selection");
        assert_eq!(result.completeness, "complete");
        assert_eq!(result.fallback_reason, None);
    }

    #[test]
    fn falls_back_to_windows_visible_nodes_before_window_title() {
        let result = select_context_text("微信", "", "客户：今天能交付吗？", false, None);

        assert_eq!(result.text, "客户：今天能交付吗？");
        assert_eq!(result.source, "accessibility_visible");
        assert_eq!(result.completeness, "partial");
    }

    #[test]
    fn marks_window_title_only_context_as_minimal() {
        let result = select_context_text("微信", "微信", "微信", false, Some("UIA unavailable"));

        assert_eq!(result.text, "微信");
        assert_eq!(result.source, "window_title");
        assert_eq!(result.completeness, "minimal");
        assert_eq!(result.fallback_reason.as_deref(), Some("UIA unavailable"));
    }

    #[test]
    fn marks_truncated_windows_accessibility_as_partial() {
        let result = select_context_text("微信", "完整正文", "", true, None);

        assert_eq!(result.source, "accessibility_document");
        assert_eq!(result.completeness, "partial");
    }

    #[test]
    fn selects_only_overlapping_bounds_for_related_window_screenshots() {
        let target = RECT {
            left: 100,
            top: 100,
            right: 900,
            bottom: 700,
        };
        let popup = RECT {
            left: 240,
            top: 180,
            right: 560,
            bottom: 420,
        };
        let outside = RECT {
            left: 1_200,
            top: 100,
            right: 1_500,
            bottom: 400,
        };

        assert!(rectangles_intersect(&popup, &target));
        assert!(!rectangles_intersect(&outside, &target));
    }

    #[test]
    fn prefers_uia_then_send_input_for_clicks() {
        assert_eq!(
            preferred_pointer_injection(&json!({ "elementId": "0.1" }), DesktopMouseButton::Left,),
            "uia"
        );
        assert_eq!(
            preferred_pointer_injection(&json!({ "elementId": "0.1" }), DesktopMouseButton::Right,),
            "send_input"
        );
        assert_eq!(
            preferred_pointer_injection(&json!({ "elementId": "0.1" }), DesktopMouseButton::Middle,),
            "send_input"
        );
        assert_eq!(
            preferred_pointer_injection(&json!({ "x": 10, "y": 20 }), DesktopMouseButton::Left,),
            "send_input"
        );
    }

    #[test]
    fn orders_primary_uia_click_actions_like_the_reference_runtime() {
        assert_eq!(
            preferred_click_action_name(true, true, true),
            Some("Invoke")
        );
        assert_eq!(
            preferred_click_action_name(false, true, true),
            Some("Select")
        );
        assert_eq!(
            preferred_click_action_name(false, false, true),
            Some("Toggle")
        );
        assert_eq!(preferred_click_action_name(false, false, false), None);
    }

    #[test]
    fn orders_send_input_key_chords_and_releases_modifiers() {
        let inputs = keyboard_input_sequence(&[VK_CONTROL, VIRTUAL_KEY(b'S' as u16)]);
        assert_eq!(inputs.len(), 4);
        unsafe {
            assert_eq!(inputs[0].Anonymous.ki.wVk, VK_CONTROL);
            assert_eq!(inputs[1].Anonymous.ki.wVk, VIRTUAL_KEY(b'S' as u16));
            assert!(inputs[2].Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP));
            assert_eq!(inputs[3].Anonymous.ki.wVk, VK_CONTROL);
            assert!(inputs[3].Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP));
        }
    }

    #[test]
    fn encodes_text_as_utf16_unicode_send_input_pairs() {
        let inputs = unicode_input_sequence("中文😀e\u{301}");
        assert_eq!(inputs.len(), 12);
        unsafe {
            assert_eq!(inputs[0].Anonymous.ki.wScan, '中' as u16);
            assert_eq!(inputs[2].Anonymous.ki.wScan, '文' as u16);
            assert_eq!(inputs[4].Anonymous.ki.wScan, 0xD83D);
            assert_eq!(inputs[6].Anonymous.ki.wScan, 0xDE00);
            assert_eq!(inputs[8].Anonymous.ki.wScan, 'e' as u16);
            assert_eq!(inputs[10].Anonymous.ki.wScan, 0x0301);
            assert!(inputs.iter().all(|input| input
                .Anonymous
                .ki
                .dwFlags
                .contains(KEYEVENTF_UNICODE)));
            assert!(inputs[11].Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP));
        }
    }

    #[test]
    fn normalizes_wgc_pixels_into_the_window_logical_coordinate_space() {
        assert_eq!(logical_capture_size(800, 600, 96), (800, 600));
        assert_eq!(logical_capture_size(1410, 1161, 120), (1128, 929));
        assert_eq!(logical_capture_size(1200, 900, 144), (800, 600));
        assert_eq!(logical_capture_size(1600, 1200, 192), (800, 600));

        let pixels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        assert_eq!(
            scale_bgra_nearest(&pixels, 2, 2, 1, 1).unwrap(),
            vec![1, 2, 3, 4],
        );
    }

    #[test]
    fn maps_mouse_buttons_to_send_input_flags() {
        assert_eq!(
            mouse_button_flags(DesktopMouseButton::Left),
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        );
        assert_eq!(
            mouse_button_flags(DesktopMouseButton::Right),
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        );
        assert_eq!(
            mouse_button_flags(DesktopMouseButton::Middle),
            (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)
        );
    }

    #[test]
    fn normalizes_reference_secondary_action_names() {
        assert_eq!(normalized_secondary_action(" invoke "), Some("Invoke"));
        assert_eq!(normalized_secondary_action("TOGGLE"), Some("Toggle"));
        assert_eq!(normalized_secondary_action("select"), Some("Select"));
        assert_eq!(normalized_secondary_action("expand"), Some("Expand"));
        assert_eq!(normalized_secondary_action("collapse"), Some("Collapse"));
        assert_eq!(
            normalized_secondary_action("scrollIntoView"),
            Some("ScrollIntoView")
        );
        assert_eq!(normalized_secondary_action("setFocus"), Some("SetFocus"));
        assert_eq!(normalized_secondary_action("AXShowMenu"), None);
    }

    #[test]
    fn keeps_focus_stealing_secondary_actions_opt_in() {
        assert!(!focus_action_enabled_from(None, None));
        assert!(focus_action_enabled_from(Some("true"), None));
        assert!(focus_action_enabled_from(None, Some("1")));
        assert!(!focus_action_enabled_from(Some("false"), Some("0")));
    }

    #[test]
    fn exposes_only_the_available_expand_or_collapse_action() {
        assert_eq!(
            expand_collapse_action_names(Some(ExpandCollapseState_Collapsed)),
            &["Expand"]
        );
        assert_eq!(
            expand_collapse_action_names(Some(ExpandCollapseState_Expanded)),
            &["Collapse"]
        );
        assert_eq!(
            expand_collapse_action_names(Some(ExpandCollapseState_PartiallyExpanded)),
            &["Collapse"]
        );
        assert_eq!(
            expand_collapse_action_names(Some(ExpandCollapseState_LeafNode)),
            &[] as &[&str]
        );
        assert_eq!(expand_collapse_action_names(None), &["Expand", "Collapse"]);
    }

    #[test]
    fn maps_negative_origin_virtual_desktop_points_to_absolute_send_input() {
        assert_eq!(
            virtual_desktop_absolute((-1920, 0), (-1920, 0, 3840, 1080)).unwrap(),
            (0, 0),
        );
        assert_eq!(
            virtual_desktop_absolute((1919, 1079), (-1920, 0, 3840, 1080)).unwrap(),
            (65_535, 65_535),
        );
    }

    #[test]
    fn document_text_uses_the_text_pattern_instead_of_control_labels() {
        let source = "  本周完成：桌面上下文绑定。\r\n下周计划：继续验证。  ";
        assert_eq!(normalize_document_text(Some(source.into())), source);
        assert_eq!(normalize_document_text(None), "");
        assert_eq!(normalize_document_text(Some("   ".into())), "");
    }

    #[test]
    fn activation_attaches_only_distinct_foreground_and_target_threads() {
        assert_eq!(activation_thread_ids(10, 20, 30), vec![20, 30]);
        assert_eq!(activation_thread_ids(10, 10, 30), vec![30]);
        assert_eq!(activation_thread_ids(10, 20, 20), vec![20]);
    }

    #[test]
    fn supports_standard_document_navigation_keys() {
        assert_eq!(virtual_key("HOME").unwrap(), VK_HOME);
        assert_eq!(virtual_key("END").unwrap(), VK_END);
        assert_eq!(virtual_key("PAGEUP").unwrap(), VK_PRIOR);
        assert_eq!(virtual_key("PAGEDOWN").unwrap(), VK_NEXT);
        assert_eq!(virtual_key("DELETE").unwrap(), VK_DELETE);
        assert_eq!(virtual_key("Control_L").unwrap(), VK_LCONTROL);
        assert_eq!(virtual_key("Control_R").unwrap(), VK_RCONTROL);
        assert_eq!(virtual_key("KP_0").unwrap(), VK_NUMPAD0);
        assert_eq!(virtual_key("Numpad_9").unwrap(), VK_NUMPAD9);
        assert_eq!(virtual_key("KP_Enter").unwrap(), VK_RETURN);
        assert_eq!(virtual_key("Numpad_Separator").unwrap(), VK_SEPARATOR);
        assert_eq!(virtual_key("semicolon").unwrap(), VK_OEM_1);
        assert_eq!(
            parse_key_chord("Control_L+s").unwrap(),
            vec![VK_LCONTROL, VIRTUAL_KEY(b'S' as u16)]
        );
        assert_eq!(
            parse_key_chord("plus").unwrap(),
            vec![VK_LSHIFT, VK_OEM_PLUS]
        );
    }

    #[test]
    fn computer_use_path_has_no_window_message_or_gdi_fallbacks() {
        let source = include_str!("windows_backend.rs");
        for forbidden in [
            concat!("Post", "MessageW"),
            concat!("WM_", "CHAR"),
            concat!("EM_", "REPLACESEL"),
            concat!("Print", "Window"),
            concat!("Bit", "Blt"),
        ] {
            assert!(
                !source.contains(forbidden),
                "forbidden Computer Use path: {forbidden}"
            );
        }
    }
}

fn virtual_key(name: &str) -> Result<VIRTUAL_KEY> {
    let normalized = name.trim().to_ascii_uppercase();
    let key = match normalized.as_str() {
        "CTRL" | "CONTROL" => VK_CONTROL,
        "CTRL_L" | "CONTROL_L" => VK_LCONTROL,
        "CTRL_R" | "CONTROL_R" => VK_RCONTROL,
        "SHIFT" => VK_SHIFT,
        "SHIFT_L" => VK_LSHIFT,
        "SHIFT_R" => VK_RSHIFT,
        "ALT" => VK_MENU,
        "ALT_L" | "META_L" => VK_LMENU,
        "ALT_R" | "META_R" => VK_RMENU,
        "SUPER_L" | "WIN_L" => VK_LWIN,
        "SUPER_R" | "WIN_R" => VK_RWIN,
        "ENTER" | "RETURN" => VK_RETURN,
        "TAB" => VK_TAB,
        "ESC" | "ESCAPE" => VK_ESCAPE,
        "BACKSPACE" => VK_BACK,
        "SPACE" => VK_SPACE,
        "DELETE" | "DEL" => VK_DELETE,
        "HOME" => VK_HOME,
        "END" => VK_END,
        "PAGEUP" | "PAGE_UP" | "PGUP" => VK_PRIOR,
        "PAGEDOWN" | "PAGE_DOWN" | "PGDN" => VK_NEXT,
        "LEFT" => VK_LEFT,
        "RIGHT" => VK_RIGHT,
        "UP" => VK_UP,
        "DOWN" => VK_DOWN,
        "KP_ADD" | "NUMPAD_ADD" => VK_ADD,
        "KP_SUBTRACT" | "NUMPAD_SUBTRACT" => VK_SUBTRACT,
        "KP_MULTIPLY" | "NUMPAD_MULTIPLY" => VK_MULTIPLY,
        "KP_DIVIDE" | "NUMPAD_DIVIDE" => VK_DIVIDE,
        "KP_DECIMAL" | "NUMPAD_DECIMAL" => VK_DECIMAL,
        "KP_ENTER" | "NUMPAD_ENTER" => VK_RETURN,
        "KP_SEPARATOR" | "NUMPAD_SEPARATOR" => VK_SEPARATOR,
        "KP_EQUAL" | "NUMPAD_EQUAL" => VK_OEM_PLUS,
        "SEMICOLON" | "COLON" | ";" | ":" => VK_OEM_1,
        "SLASH" | "QUESTION" | "/" | "?" => VK_OEM_2,
        "GRAVE" | "ASCIITILDE" | "`" | "~" => VK_OEM_3,
        "BRACKETLEFT" | "BRACELEFT" | "[" | "{" => VK_OEM_4,
        "BACKSLASH" | "BAR" | "\\" | "|" => VK_OEM_5,
        "BRACKETRIGHT" | "BRACERIGHT" | "]" | "}" => VK_OEM_6,
        "APOSTROPHE" | "QUOTEDBL" | "'" | "\"" => VK_OEM_7,
        "COMMA" | "LESS" | "," | "<" => VK_OEM_COMMA,
        "MINUS" | "UNDERSCORE" | "-" | "_" => VK_OEM_MINUS,
        "PERIOD" | "GREATER" | "." | ">" => VK_OEM_PERIOD,
        "EQUAL" | "PLUS" | "=" | "+" => VK_OEM_PLUS,
        value if value.starts_with("KP_") || value.starts_with("NUMPAD_") => {
            let digit = value
                .rsplit('_')
                .next()
                .and_then(|value| value.parse::<u16>().ok());
            match digit {
                Some(0) => VK_NUMPAD0,
                Some(1) => VK_NUMPAD1,
                Some(2) => VK_NUMPAD2,
                Some(3) => VK_NUMPAD3,
                Some(4) => VK_NUMPAD4,
                Some(5) => VK_NUMPAD5,
                Some(6) => VK_NUMPAD6,
                Some(7) => VK_NUMPAD7,
                Some(8) => VK_NUMPAD8,
                Some(9) => VK_NUMPAD9,
                _ => return Err(anyhow!("unsupported key: {name}")),
            }
        }
        value if value.starts_with('F') => {
            let number = value[1..].parse::<u16>().ok();
            match number.filter(|number| (1..=24).contains(number)) {
                Some(number) => VIRTUAL_KEY(0x6F + number),
                None => return Err(anyhow!("unsupported key: {name}")),
            }
        }
        value if value.len() == 1 && value.as_bytes()[0].is_ascii_alphanumeric() => {
            VIRTUAL_KEY(value.as_bytes()[0] as u16)
        }
        _ => return Err(anyhow!("unsupported key: {name}")),
    };
    Ok(key)
}

fn parse_key_chord(chord: &str) -> Result<Vec<VIRTUAL_KEY>> {
    let parts = if chord.trim() == "+" {
        vec!["+"]
    } else {
        chord.split('+').map(str::trim).collect::<Vec<_>>()
    };
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err(anyhow!("invalid key chord: {chord}"));
    }
    let mut keys = parts
        .iter()
        .map(|part| virtual_key(part))
        .collect::<Result<Vec<_>>>()?;
    if parts.last().is_some_and(|part| keysym_requires_shift(part))
        && !keys
            .iter()
            .any(|key| matches!(*key, VK_SHIFT | VK_LSHIFT | VK_RSHIFT))
    {
        let insert_at = keys.len().saturating_sub(1);
        keys.insert(insert_at, VK_LSHIFT);
    }
    Ok(keys)
}

fn keysym_requires_shift(name: &str) -> bool {
    matches!(
        name.trim(),
        ":" | "?" | "~" | "{" | "|" | "}" | "\"" | "<" | "_" | ">" | "+"
    ) || matches!(
        name.trim().to_ascii_uppercase().as_str(),
        "COLON"
            | "QUESTION"
            | "ASCIITILDE"
            | "BRACELEFT"
            | "BAR"
            | "BRACERIGHT"
            | "QUOTEDBL"
            | "LESS"
            | "UNDERSCORE"
            | "GREATER"
            | "PLUS"
    ) || (name.len() == 1 && name.as_bytes()[0].is_ascii_uppercase())
}

fn int_param(params: &Value, name: &str) -> Result<i32> {
    params
        .get(name)
        .and_then(Value::as_i64)
        .map(|value| value as i32)
        .ok_or_else(|| anyhow!("{name} is required"))
}

fn number_param(params: &Value, name: &str) -> Result<f64> {
    params
        .get(name)
        .and_then(Value::as_f64)
        .ok_or_else(|| anyhow!("{name} is required"))
}

fn stale_target() -> Value {
    json!({ "status": "stale_target", "message": "target window is unavailable" })
}

fn failed_action(message: &str) -> Value {
    json!({ "status": "failed", "message": message })
}

fn invalid_secondary_action(action: &str, element_id: &str) -> Value {
    failed_action(&format!(
        "{action} is not a valid secondary action for {element_id}"
    ))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
