use std::{
    collections::BTreeMap, ffi::c_void, mem::size_of, path::Path, process::Command, thread,
    time::Duration,
};

use crate::windows_cursor_motion::{
    cursor_motion_frame_points, spring_close_enough_time_seconds, CursorBounds, CursorPoint,
    CursorVector,
};
use crate::windows_overlay::{
    move_visual_cursor, pulse_visual_cursor, settle_visual_cursor, VISUAL_CURSOR_WINDOW_TITLE,
};
use crate::DesktopBackend;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use windows::{
    core::{BOOL, BSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT},
        Graphics::Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
            GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
            DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
        },
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
            Threading::{
                AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
                IUIAutomationTextPattern, IUIAutomationTreeWalker, IUIAutomationValuePattern, UIA_ButtonControlTypeId,
                UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_GroupControlTypeId,
                UIA_InvokePatternId, UIA_ListControlTypeId, UIA_ListItemControlTypeId,
                UIA_MenuItemControlTypeId, UIA_PaneControlTypeId, UIA_TabItemControlTypeId,
                UIA_TextControlTypeId, UIA_TextPatternId, UIA_ValuePatternId, UIA_WindowControlTypeId,
                UIA_CONTROLTYPE_ID,
            },
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
                KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
                MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT,
                VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME,
                VK_LEFT, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_TAB, VK_UP,
            },
            WindowsAndMessaging::{
                BringWindowToTop, EnumWindows, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowRect,
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
                IsWindowVisible, SetCursorPos, SetForegroundWindow, ShowWindow, SM_CXVIRTUALSCREEN,
                SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE,
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
            "wait_for_state" => wait_for_state(params),
            "current_context" => current_context(),
            "launch_app" => launch_app(params),
            "activate_window" => with_window(params, |hwnd| activate(hwnd)),
            "move_pointer" => move_pointer(params),
            "click" => click(params, false),
            "perform_secondary_action" => click(params, true),
            "scroll" => scroll(params),
            "drag" => drag(params),
            "press_key" => press_key(params),
            "type_text" => guarded_text_action(params, type_text),
            "set_value" => guarded_text_action(params, set_value),
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

fn wait_for_state(params: &Value) -> Result<Value> {
    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(5_000)
        .min(30_000);
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let state = get_window_state(params)?;
        if state_matches(&state, params) {
            return Ok(state);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(
                json!({ "status": "timeout", "message": "desktop window state did not match before timeout" }),
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn state_matches(state: &Value, params: &Value) -> bool {
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

fn guarded_text_action(params: &Value, action: fn(&Value) -> Result<Value>) -> Result<Value> {
    if sensitive_text_target(params)? {
        return Ok(json!({
            "status": "blocked",
            "message": "sensitive fields require a dedicated secure credential flow"
        }));
    }
    action(params)
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
    for hwnd in enumerate_windows()? {
        if let Some(window) = window_json(hwnd) {
            let app_id = window["appId"].as_str().unwrap_or_default().to_owned();
            apps.entry(app_id.clone()).or_insert_with(|| {
                json!({
                    "id": app_id,
                    "name": window["appName"],
                    "processId": window["processId"],
                    "platformId": window["platformId"],
                })
            });
        }
    }
    Ok(json!({ "status": "ok", "apps": apps.into_values().collect::<Vec<_>>() }))
}

fn get_window(params: &Value) -> Result<Value> {
    let Some(hwnd) = target_window(params) else {
        return Ok(stale_target());
    };
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
    let revision = window_revision(&window);
    let screenshots = screenshot_refs(
        hwnd,
        &window,
        params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
    );
    let accessibility = accessibility_state(hwnd).unwrap_or_else(|error| {
        json!({
            "tree": [],
            "documentText": title,
            "unavailableReason": error.to_string(),
        })
    });
    Ok(json!({
        "status": "ok",
        "window": window,
        "revision": revision,
        "capturedAt": now_millis(),
        "screenshots": screenshots,
        "accessibility": accessibility,
    }))
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
    let Some(expected_revision) = params.get("windowRevision").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(hwnd) = target_window(params) else {
        return Ok(Some(stale_target()));
    };
    let Some(window) = window_json(hwnd) else {
        return Ok(Some(stale_target()));
    };
    if window_revision(&window) != expected_revision {
        return Ok(Some(stale_target()));
    }
    Ok(None)
}

fn window_revision(window: &Value) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}",
        window["id"].as_str().unwrap_or_default(),
        window["title"].as_str().unwrap_or_default(),
        window["bounds"]["x"],
        window["bounds"]["y"],
        window["bounds"]["width"],
        window["bounds"]["height"],
    )
}

fn current_context() -> Result<Value> {
    let hwnd = unsafe { GetForegroundWindow() };
    let Some(window) = window_json(hwnd) else {
        return Ok(stale_target());
    };
    let accessibility = accessibility_state(hwnd).unwrap_or_else(|_| json!({}));
    let visible_text = accessibility
        .get("documentText")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| window["title"].as_str().unwrap_or_default());
    Ok(json!({
        "status": "ok",
        "snapshot": {
            "id": format!("foreground:{}", now_millis()),
            "app": {
                "id": window["appId"],
                "name": window["appName"],
                "processId": window["processId"],
            },
            "window": window,
            "capturedAt": now_millis(),
            "eventType": "foreground_changed",
            "visibleText": visible_text,
            "screenshotId": screenshot_id(&window),
            "untrusted": true,
        }
    }))
}

fn screenshot_refs(hwnd: HWND, window: &Value, include_pixels: bool) -> Vec<Value> {
    let width = window["bounds"]["width"]
        .as_i64()
        .unwrap_or_default()
        .max(0) as i32;
    let height = window["bounds"]["height"]
        .as_i64()
        .unwrap_or_default()
        .max(0) as i32;
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let mut screenshot = json!({
        "id": screenshot_id(window),
        "width": width,
        "height": height,
        "origin": {
            "x": window["bounds"]["x"],
            "y": window["bounds"]["y"],
        },
        "mimeType": "image/bmp",
    });
    if include_pixels {
        match capture_window_bmp_data_url(hwnd, width, height) {
            Ok(data_url) => {
                screenshot["dataUrl"] = Value::String(data_url);
            }
            Err(error) => {
                screenshot["error"] = Value::String(error.to_string());
            }
        }
    }
    vec![screenshot]
}

fn screenshot_id(window: &Value) -> String {
    format!(
        "screenshot:{}:{}",
        window["id"].as_str().unwrap_or_default(),
        window_revision(window)
    )
}

fn capture_window_bmp_data_url(hwnd: HWND, width: i32, height: i32) -> Result<String> {
    let mut rect = RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect)?;
    }
    let screen_dc = unsafe { GetDC(None) };
    if screen_dc.is_invalid() {
        return Err(anyhow!("unable to acquire screen device context"));
    }
    let memory_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if memory_dc.is_invalid() {
        unsafe {
            ReleaseDC(None, screen_dc);
        }
        return Err(anyhow!("unable to create capture device context"));
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width, height) };
    if bitmap.is_invalid() {
        unsafe {
            let _ = DeleteDC(memory_dc);
            ReleaseDC(None, screen_dc);
        }
        return Err(anyhow!("unable to create capture bitmap"));
    }

    let old_object = unsafe { SelectObject(memory_dc, HGDIOBJ::from(bitmap)) };
    let capture_result = unsafe {
        BitBlt(
            memory_dc,
            0,
            0,
            width,
            height,
            Some(screen_dc),
            rect.left,
            rect.top,
            SRCCOPY,
        )
    };
    let result = capture_result
        .map_err(|error| anyhow!("window capture failed: {error}"))
        .and_then(|_| bitmap_to_bmp_data_url(memory_dc, bitmap, width, height));
    unsafe {
        if !old_object.is_invalid() {
            SelectObject(memory_dc, old_object);
        }
        let _ = DeleteObject(HGDIOBJ::from(bitmap));
        let _ = DeleteDC(memory_dc);
        ReleaseDC(None, screen_dc);
    }
    result
}

fn bitmap_to_bmp_data_url(
    memory_dc: windows::Win32::Graphics::Gdi::HDC,
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    width: i32,
    height: i32,
) -> Result<String> {
    let pixel_bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow!("window capture dimensions are too large"))?;
    let mut pixels = vec![0_u8; pixel_bytes];
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: pixel_bytes as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let copied = unsafe {
        GetDIBits(
            memory_dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if copied == 0 {
        return Err(anyhow!("unable to read captured bitmap"));
    }
    let mut bmp = Vec::with_capacity(14 + size_of::<BITMAPINFOHEADER>() + pixels.len());
    let file_size = (14 + size_of::<BITMAPINFOHEADER>() + pixels.len()) as u32;
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_size.to_le_bytes());
    bmp.extend_from_slice(&0_u16.to_le_bytes());
    bmp.extend_from_slice(&0_u16.to_le_bytes());
    bmp.extend_from_slice(&(14_u32 + size_of::<BITMAPINFOHEADER>() as u32).to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biSize.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biWidth.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biHeight.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biPlanes.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biBitCount.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biCompression.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biSizeImage.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biXPelsPerMeter.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biYPelsPerMeter.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biClrUsed.to_le_bytes());
    bmp.extend_from_slice(&info.bmiHeader.biClrImportant.to_le_bytes());
    bmp.extend_from_slice(&pixels);
    Ok(format!("data:image/bmp;base64,{}", BASE64.encode(bmp)))
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
        let tree = collect_accessibility_children(
            &walker,
            &root,
            "root",
            0,
            &mut remaining,
            &mut text,
            &mut document_text,
        );
        let focused = find_focused_element(&tree);
        Ok(json!({
            "tree": tree,
            "focusedElement": focused,
            "documentText": normalize_document_text(document_text),
            "visibleText": text.join("\n"),
            "truncated": remaining == 0,
        }))
    }
}

unsafe fn collect_accessibility_children(
    walker: &IUIAutomationTreeWalker,
    parent: &IUIAutomationElement,
    parent_path: &str,
    depth: usize,
    remaining: &mut usize,
    text: &mut Vec<String>,
    document_text: &mut Option<String>,
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
        let children = unsafe {
            collect_accessibility_children(
                walker,
                &element,
                &path,
                depth + 1,
                remaining,
                text,
                document_text,
            )
        };
        result.push(json!({
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
        }));
        index += 1;
        child = unsafe { walker.GetNextSiblingElement(&element) }.ok();
    }
    result
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
    text.filter(|value| !value.trim().is_empty()).unwrap_or_default()
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
    Command::new(command).spawn()?;
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
        let attached_threads = activation_thread_ids(current_thread, foreground_thread, target_thread);
        for thread_id in &attached_threads {
            let _ = AttachThreadInput(current_thread, *thread_id, true);
        }

        let _ = BringWindowToTop(hwnd);
        let activated = SetForegroundWindow(hwnd).as_bool() || GetForegroundWindow() == hwnd;

        for thread_id in attached_threads.iter().rev() {
            let _ = AttachThreadInput(current_thread, *thread_id, false);
        }
        if !activated {
            return Err(anyhow!("unable to activate target window"));
        }
    }
    Ok(())
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

fn move_pointer(params: &Value) -> Result<Value> {
    let target = target_window(params);
    if let Some(hwnd) = target {
        activate(hwnd)?;
    }
    let (x, y) = action_point(params)?;
    animate_pointer(x, y, target)?;
    Ok(json!({ "status": "ok" }))
}

fn click(params: &Value, secondary: bool) -> Result<Value> {
    let target = target_window(params);
    let semantic = preferred_pointer_injection(params, secondary) == "uia";
    if requires_foreground_activation(params, secondary) {
        if let Some(hwnd) = target {
            activate(hwnd)?;
        }
    }
    let point = if params.get("elementId").is_some()
        || (params.get("x").is_some() && params.get("y").is_some())
    {
        let point = action_point(params)?;
        if semantic {
            animate_visual_pointer(point.0, point.1, target);
        } else {
            animate_pointer(point.0, point.1, target)?;
        }
        point
    } else {
        current_pointer()?
    };
    if semantic && try_invoke_element(params)? {
        pulse_visual_cursor(point.0, point.1, target);
        return Ok(json!({ "status": "ok", "inputMode": "uia_invoke" }));
    }
    if semantic {
        if let Some(hwnd) = target {
            activate(hwnd)?;
        }
        animate_physical_pointer(point.0, point.1)?;
    }
    if secondary {
        send_mouse(MOUSEEVENTF_RIGHTDOWN, 0)?;
        send_mouse(MOUSEEVENTF_RIGHTUP, 0)?;
    } else {
        send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
        send_mouse(MOUSEEVENTF_LEFTUP, 0)?;
    }
    pulse_visual_cursor(point.0, point.1, target);
    Ok(json!({ "status": "ok", "inputMode": "physical_pointer" }))
}

fn scroll(params: &Value) -> Result<Value> {
    let target = target_window(params);
    if let Some(hwnd) = target {
        activate(hwnd)?;
    }
    let point = current_pointer()?;
    settle_visual_cursor(point.0, point.1, target);
    let delta = params.get("deltaY").and_then(Value::as_i64).unwrap_or(0) as i32;
    send_mouse(MOUSEEVENTF_WHEEL, (-delta).cast_unsigned())?;
    Ok(json!({ "status": "ok" }))
}

fn drag(params: &Value) -> Result<Value> {
    let target = target_window(params);
    if let Some(hwnd) = target {
        activate(hwnd)?;
    }
    animate_pointer(
        int_param(params, "fromX")?,
        int_param(params, "fromY")?,
        target,
    )?;
    send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
    let to_x = int_param(params, "toX")?;
    let to_y = int_param(params, "toY")?;
    animate_pointer(to_x, to_y, target)?;
    send_mouse(MOUSEEVENTF_LEFTUP, 0)?;
    pulse_visual_cursor(to_x, to_y, target);
    Ok(json!({ "status": "ok" }))
}

fn press_key(params: &Value) -> Result<Value> {
    if let Some(hwnd) = target_window(params) {
        activate(hwnd)?;
    }
    let keys = params
        .get("keys")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .or_else(|| {
            params
                .get("key")
                .and_then(Value::as_str)
                .map(|key| key.split('+').collect())
        })
        .unwrap_or_default();
    if keys.is_empty() {
        return Ok(json!({ "status": "failed", "message": "key or keys is required" }));
    }
    let virtual_keys = keys
        .iter()
        .map(|key| virtual_key(key))
        .collect::<Result<Vec<_>>>()?;
    for key in &virtual_keys {
        send_virtual_key(*key, false)?;
    }
    for key in virtual_keys.iter().rev() {
        send_virtual_key(*key, true)?;
    }
    Ok(json!({ "status": "ok" }))
}

fn type_text(params: &Value) -> Result<Value> {
    if let Some(hwnd) = target_window(params) {
        activate(hwnd)?;
    }
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    send_unicode(text)?;
    Ok(json!({ "status": "ok" }))
}

fn set_value(params: &Value) -> Result<Value> {
    let target = target_window(params);
    let semantic = preferred_pointer_injection(params, false) == "uia";
    if !semantic {
        if let Some(hwnd) = target {
            activate(hwnd)?;
        }
    }
    if params.get("elementId").is_some() {
        let (x, y) = action_point(params)?;
        animate_visual_pointer(x, y, target);
        let value = params
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if try_set_element_value(params, value)? {
            pulse_visual_cursor(x, y, target);
            return Ok(json!({ "status": "ok", "inputMode": "uia_value" }));
        }
        if let Some(hwnd) = target {
            activate(hwnd)?;
        }
        animate_physical_pointer(x, y)?;
        send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
        send_mouse(MOUSEEVENTF_LEFTUP, 0)?;
        pulse_visual_cursor(x, y, target);
    }
    let value = params
        .get("value")
        .and_then(Value::as_str)
        .unwrap_or_default();
    send_virtual_key(VK_CONTROL, false)?;
    send_virtual_key(VIRTUAL_KEY(b'A' as u16), false)?;
    send_virtual_key(VIRTUAL_KEY(b'A' as u16), true)?;
    send_virtual_key(VK_CONTROL, true)?;
    send_unicode(value)?;
    Ok(json!({ "status": "ok", "inputMode": "keyboard_fallback" }))
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
        let app_name = process_name(process_id).unwrap_or_else(|| format!("process-{process_id}"));
        let app_id = app_name.to_lowercase();
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
            "processId": process_id,
            "platformId": format!("{}", hwnd.0 as usize),
        }))
    }
}

fn process_name(process_id: u32) -> Option<String> {
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
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        Path::new(&path).file_name()?.to_str().map(str::to_owned)
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

fn animate_pointer(x: i32, y: i32, target_window: Option<HWND>) -> Result<()> {
    move_visual_cursor(x, y, target_window);
    animate_physical_pointer(x, y)?;
    settle_visual_cursor(x, y, target_window);
    Ok(())
}

fn animate_visual_pointer(x: i32, y: i32, target_window: Option<HWND>) {
    move_visual_cursor(x, y, target_window);
    thread::sleep(Duration::from_secs_f64(spring_close_enough_time_seconds()));
    settle_visual_cursor(x, y, target_window);
}

fn animate_physical_pointer(x: i32, y: i32) -> Result<()> {
    let mut from = POINT::default();
    unsafe {
        GetCursorPos(&mut from)?;
    }
    let start = CursorPoint {
        x: f64::from(from.x),
        y: f64::from(from.y),
    };
    let end = CursorPoint {
        x: f64::from(x),
        y: f64::from(y),
    };
    let neutral = CursorVector::new(-1.0, -1.0).normalized();
    for point in cursor_motion_frame_points(
        start,
        end,
        virtual_desktop_bounds(start, end),
        neutral,
        neutral,
        1.0 / 60.0,
    ) {
        unsafe {
            SetCursorPos(point.x.round() as i32, point.y.round() as i32)?;
        }
        thread::sleep(Duration::from_millis(16));
    }
    Ok(())
}

fn virtual_desktop_bounds(start: CursorPoint, end: CursorPoint) -> CursorBounds {
    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width > 0 && height > 0 {
        return CursorBounds::new(
            f64::from(x),
            f64::from(y),
            f64::from(width),
            f64::from(height),
        );
    }
    CursorBounds::new(
        start.x.min(end.x) - 200.0,
        start.y.min(end.y) - 200.0,
        (start.x - end.x).abs() + 400.0,
        (start.y - end.y).abs() + 400.0,
    )
}

fn preferred_pointer_injection(params: &Value, secondary: bool) -> &'static str {
    if !secondary && params.get("elementId").and_then(Value::as_str).is_some() {
        "uia"
    } else {
        "physical"
    }
}

fn requires_foreground_activation(params: &Value, secondary: bool) -> bool {
    preferred_pointer_injection(params, secondary) == "physical"
}

fn try_invoke_element(params: &Value) -> Result<bool> {
    let Some(element) = resolve_element(params)? else {
        return Ok(false);
    };
    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) };
    let Ok(pattern) = pattern else {
        return Ok(false);
    };
    unsafe {
        pattern.Invoke()?;
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

fn current_pointer() -> Result<(i32, i32)> {
    let mut point = POINT::default();
    unsafe {
        GetCursorPos(&mut point)?;
    }
    Ok((point.x, point.y))
}

fn send_mouse(
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    data: u32,
) -> Result<()> {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                mouseData: data,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    send_inputs(&[input])
}

fn send_virtual_key(key: VIRTUAL_KEY, key_up: bool) -> Result<()> {
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if key_up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    };
    send_inputs(&[input])
}

fn send_unicode(text: &str) -> Result<()> {
    let mut inputs = Vec::new();
    for unit in text.encode_utf16() {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE,
                    ..Default::default()
                },
            },
        });
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        });
    }
    send_inputs(&inputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_uia_for_element_scoped_primary_actions() {
        assert_eq!(
            preferred_pointer_injection(&json!({ "elementId": "0.1" }), false),
            "uia"
        );
        assert_eq!(
            preferred_pointer_injection(&json!({ "elementId": "0.1" }), true),
            "physical"
        );
        assert_eq!(
            preferred_pointer_injection(&json!({ "x": 10, "y": 20 }), false),
            "physical"
        );
        assert!(!requires_foreground_activation(
            &json!({ "elementId": "0.1" }),
            false
        ));
        assert!(requires_foreground_activation(
            &json!({ "elementId": "0.1" }),
            true
        ));
    }

    #[test]
    fn document_text_uses_the_text_pattern_instead_of_control_labels() {
        let source = "  本周完成：桌面上下文绑定。\r\n下周计划：继续验证。  ";
        assert_eq!(
            normalize_document_text(Some(source.into())),
            source
        );
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
    }
}

fn send_inputs(inputs: &[INPUT]) -> Result<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err(anyhow!("SendInput accepted {sent}/{} events", inputs.len()));
    }
    Ok(())
}

fn virtual_key(name: &str) -> Result<VIRTUAL_KEY> {
    let normalized = name.trim().to_ascii_uppercase();
    let key = match normalized.as_str() {
        "CTRL" | "CONTROL" => VK_CONTROL,
        "SHIFT" => VK_SHIFT,
        "ALT" => VK_MENU,
        "ENTER" | "RETURN" => VK_RETURN,
        "TAB" => VK_TAB,
        "ESC" | "ESCAPE" => VK_ESCAPE,
        "BACKSPACE" => VK_BACK,
        "DELETE" | "DEL" => VK_DELETE,
        "HOME" => VK_HOME,
        "END" => VK_END,
        "PAGEUP" | "PAGE_UP" | "PGUP" => VK_PRIOR,
        "PAGEDOWN" | "PAGE_DOWN" | "PGDN" => VK_NEXT,
        "LEFT" => VK_LEFT,
        "RIGHT" => VK_RIGHT,
        "UP" => VK_UP,
        "DOWN" => VK_DOWN,
        value if value.len() == 1 => VIRTUAL_KEY(value.as_bytes()[0] as u16),
        _ => return Err(anyhow!("unsupported key: {name}")),
    };
    Ok(key)
}

fn int_param(params: &Value, name: &str) -> Result<i32> {
    params
        .get(name)
        .and_then(Value::as_i64)
        .map(|value| value as i32)
        .ok_or_else(|| anyhow!("{name} is required"))
}

fn stale_target() -> Value {
    json!({ "status": "stale_target", "message": "target window is unavailable" })
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
