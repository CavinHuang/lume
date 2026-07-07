use std::{
    collections::BTreeMap, ffi::c_void, mem::size_of, path::Path, process::Command, thread,
    time::Duration,
};

use crate::DesktopBackend;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use windows::{
    core::{BOOL, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker,
                UIA_ButtonControlTypeId, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
                UIA_GroupControlTypeId, UIA_ListControlTypeId, UIA_ListItemControlTypeId,
                UIA_MenuItemControlTypeId, UIA_PaneControlTypeId, UIA_TabItemControlTypeId,
                UIA_TextControlTypeId, UIA_WindowControlTypeId, UIA_CONTROLTYPE_ID,
            },
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
                KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
                MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT,
                VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DOWN, VK_ESCAPE, VK_LEFT, VK_MENU, VK_RETURN,
                VK_RIGHT, VK_SHIFT, VK_TAB, VK_UP,
            },
            WindowsAndMessaging::{
                EnumWindows, GetCursorPos, GetForegroundWindow, GetWindowRect,
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
                IsWindowVisible, SetCursorPos, SetForegroundWindow, ShowWindow, SW_RESTORE,
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
        "screenshots": [],
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
            "untrusted": true,
        }
    }))
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
        let tree =
            collect_accessibility_children(&walker, &root, "root", 0, &mut remaining, &mut text);
        let focused = find_focused_element(&tree);
        Ok(json!({
            "tree": tree,
            "focusedElement": focused,
            "documentText": text.join("\n"),
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
        let children = unsafe {
            collect_accessibility_children(walker, &element, &path, depth + 1, remaining, text)
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
        if !SetForegroundWindow(hwnd).as_bool() {
            return Err(anyhow!("unable to activate target window"));
        }
    }
    Ok(())
}

fn move_pointer(params: &Value) -> Result<Value> {
    if let Some(hwnd) = target_window(params) {
        activate(hwnd)?;
    }
    let (x, y) = action_point(params)?;
    animate_pointer(x, y)?;
    Ok(json!({ "status": "ok" }))
}

fn click(params: &Value, secondary: bool) -> Result<Value> {
    if let Some(hwnd) = target_window(params) {
        activate(hwnd)?;
    }
    if params.get("elementId").is_some() || (params.get("x").is_some() && params.get("y").is_some())
    {
        let (x, y) = action_point(params)?;
        animate_pointer(x, y)?;
    }
    if secondary {
        send_mouse(MOUSEEVENTF_RIGHTDOWN, 0)?;
        send_mouse(MOUSEEVENTF_RIGHTUP, 0)?;
    } else {
        send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
        send_mouse(MOUSEEVENTF_LEFTUP, 0)?;
    }
    Ok(json!({ "status": "ok" }))
}

fn scroll(params: &Value) -> Result<Value> {
    if let Some(hwnd) = target_window(params) {
        activate(hwnd)?;
    }
    let delta = params.get("deltaY").and_then(Value::as_i64).unwrap_or(0) as i32;
    send_mouse(MOUSEEVENTF_WHEEL, (-delta).cast_unsigned())?;
    Ok(json!({ "status": "ok" }))
}

fn drag(params: &Value) -> Result<Value> {
    if let Some(hwnd) = target_window(params) {
        activate(hwnd)?;
    }
    animate_pointer(int_param(params, "fromX")?, int_param(params, "fromY")?)?;
    send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
    animate_pointer(int_param(params, "toX")?, int_param(params, "toY")?)?;
    send_mouse(MOUSEEVENTF_LEFTUP, 0)?;
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
    if let Some(hwnd) = target_window(params) {
        activate(hwnd)?;
    }
    if params.get("elementId").is_some() {
        let (x, y) = action_point(params)?;
        animate_pointer(x, y)?;
        send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
        send_mouse(MOUSEEVENTF_LEFTUP, 0)?;
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
    Ok(json!({ "status": "ok" }))
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

fn animate_pointer(x: i32, y: i32) -> Result<()> {
    let mut from = POINT::default();
    unsafe {
        GetCursorPos(&mut from)?;
    }
    const STEPS: i32 = 8;
    for step in 1..=STEPS {
        let next_x = from.x + (x - from.x) * step / STEPS;
        let next_y = from.y + (y - from.y) * step / STEPS;
        unsafe {
            SetCursorPos(next_x, next_y)?;
        }
        thread::sleep(Duration::from_millis(18));
    }
    Ok(())
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
