use crate::{
    desktop_permission_diagnostics,
    macos_snapshot::{
        find_macos_window, first_visible_user_window, macos_current_context_result,
        macos_get_window_result, macos_get_window_state_result, macos_key_chord,
        macos_list_apps_result, macos_list_windows_result, macos_preferred_click_actions,
        macos_resolve_action_point, macos_text_target_is_sensitive, macos_wait_for_state_result,
        MacOSElementInfo, MacOSWindowInfo, MACOS_EVENT_FLAG_MASK_COMMAND,
    },
    DesktopBackend,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{
    ffi::{CStr, CString},
    os::raw::{c_char, c_double, c_int, c_long, c_uchar, c_uint, c_ulong, c_ushort, c_void},
    process::Command,
    ptr, thread,
    time::{Duration, Instant},
};

pub struct MacOSDesktopBackend;

impl DesktopBackend for MacOSDesktopBackend {
    fn invoke(&self, method: &str, params: &Value) -> Result<Value> {
        let permissions = permission_state();
        if method == "diagnose_permissions" {
            return Ok(desktop_permission_diagnostics(
                Some(permissions.accessibility),
                Some(permissions.screen_recording),
                None,
            ));
        }
        if method == "request_permissions" {
            return Ok(request_permissions(permissions));
        }
        if !permissions.all_granted() {
            return Ok(desktop_permission_diagnostics(
                Some(permissions.accessibility),
                Some(permissions.screen_recording),
                Some("macOS desktop control requires Accessibility and Screen Recording permissions for Lume Computer Use.app".to_owned()),
            ));
        }
        if method == "wait_for_state" {
            return wait_for_state(params);
        }
        if method == "launch_app" {
            return Ok(launch_app(params));
        }
        let windows = system_windows()?;
        match method {
            "list_windows" => Ok(macos_list_windows_result(
                &windows,
                params.get("appId").and_then(Value::as_str),
            )),
            "list_apps" => Ok(macos_list_apps_result(&windows)),
            "get_window" => {
                let window = match params.get("windowId").and_then(Value::as_str) {
                    Some(window_id) => find_macos_window(&windows, window_id),
                    None => first_visible_user_window(&windows),
                };
                Ok(macos_get_window_result(window))
            }
            "current_context" => {
                let Some(mut window) = first_visible_user_window(&windows) else {
                    return Ok(stale_target());
                };
                enrich_accessibility_text(&mut window);
                Ok(macos_current_context_result(
                    &window,
                    params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
                ))
            }
            "get_window_state" => {
                let window = match params.get("windowId").and_then(Value::as_str) {
                    Some(window_id) => find_macos_window(&windows, window_id),
                    None => first_visible_user_window(&windows),
                };
                let Some(window) = window else {
                    return Ok(stale_target());
                };
                let mut window = window;
                enrich_accessibility_text(&mut window);
                Ok(macos_get_window_state_result(
                    &window,
                    params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
                ))
            }
            "activate_window" => activate_window(params, &windows),
            "move_pointer" => move_pointer(params, &windows),
            "click" => click(params, &windows, false),
            "perform_secondary_action" => click(params, &windows, true),
            "scroll" => scroll(params, &windows),
            "drag" => drag(params, &windows),
            "press_key" => press_key(params, &windows),
            "type_text" => guarded_text_action(params, &windows, type_text),
            "set_value" => guarded_text_action(params, &windows, set_value),
            _ => Ok(json!({
                "status": "unavailable",
                "message": format!("desktop method is not implemented on macOS yet: {method}")
            })),
        }
    }
}

fn launch_app(params: &Value) -> Value {
    let mut command = Command::new("/usr/bin/open");
    if let Some(path) = params.get("path").and_then(Value::as_str) {
        command.arg(path);
    } else if let Some(app) = params.get("app").and_then(Value::as_str) {
        command.arg("-a").arg(app);
    } else {
        return failed_action("app or path is required");
    }
    match command.spawn() {
        Ok(_) => json!({ "status": "ok" }),
        Err(error) => failed_action(&format!("failed to launch app: {error}")),
    }
}

fn activate_window(params: &Value, windows: &[MacOSWindowInfo]) -> Result<Value> {
    let Some(window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
    activate_macos_window(&window)?;
    Ok(json!({ "status": "ok" }))
}

fn move_pointer(params: &Value, windows: &[MacOSWindowInfo]) -> Result<Value> {
    let Some(mut window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
    enrich_accessibility_text(&mut window);
    let (x, y) = match macos_resolve_action_point(&window, params) {
        Ok(point) => point,
        Err(result) => return Ok(result),
    };
    activate_macos_window(&window)?;
    move_mouse(x, y);
    Ok(json!({ "status": "ok" }))
}

fn click(params: &Value, windows: &[MacOSWindowInfo], secondary: bool) -> Result<Value> {
    let Some(mut window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
    enrich_accessibility_text(&mut window);
    if let Some(element_id) = params.get("elementId").and_then(Value::as_str) {
        activate_macos_window(&window)?;
        if let Some(input_mode) = perform_element_click_action(&window, element_id, secondary)? {
            return Ok(json!({ "status": "ok", "inputMode": input_mode }));
        }
    }
    let (x, y) = match macos_resolve_action_point(&window, params) {
        Ok(point) => point,
        Err(result) => return Ok(result),
    };
    activate_macos_window(&window)?;
    move_mouse(x, y);
    click_mouse(x, y, secondary);
    Ok(json!({ "status": "ok", "inputMode": "physical_pointer" }))
}

fn perform_element_click_action(
    window: &MacOSWindowInfo,
    element_id: &str,
    secondary: bool,
) -> Result<Option<&'static str>> {
    unsafe {
        let app = AXUIElementCreateApplication(window.owner_pid as c_int);
        if app.is_null() {
            return Ok(None);
        }
        let root = matching_ax_window(app, window.window_id).or_else(|| first_ax_window(app));
        let Some(root) = root else {
            CFRelease(app as CFTypeRef);
            return Ok(None);
        };
        let element = matching_ax_element_by_id(root, element_id);
        let handled = element.is_some_and(|element| {
            let handled = macos_preferred_click_actions(secondary)
                .iter()
                .any(|action| perform_ax_action(element, action));
            CFRelease(element as CFTypeRef);
            handled
        });
        CFRelease(root as CFTypeRef);
        CFRelease(app as CFTypeRef);
        Ok(handled.then_some(if secondary {
            "accessibility_menu"
        } else {
            "accessibility_action"
        }))
    }
}

fn scroll(params: &Value, windows: &[MacOSWindowInfo]) -> Result<Value> {
    let Some(window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
    let delta = params.get("deltaY").and_then(Value::as_i64).unwrap_or(0) as c_int;
    activate_macos_window(&window)?;
    scroll_mouse(-delta);
    Ok(json!({ "status": "ok" }))
}

fn drag(params: &Value, windows: &[MacOSWindowInfo]) -> Result<Value> {
    let Some(window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
    let Some(from_x) = numeric_param(params, "fromX") else {
        return Ok(failed_action("fromX is required"));
    };
    let Some(from_y) = numeric_param(params, "fromY") else {
        return Ok(failed_action("fromY is required"));
    };
    let Some(to_x) = numeric_param(params, "toX") else {
        return Ok(failed_action("toX is required"));
    };
    let Some(to_y) = numeric_param(params, "toY") else {
        return Ok(failed_action("toY is required"));
    };
    activate_macos_window(&window)?;
    drag_mouse(from_x, from_y, to_x, to_y);
    Ok(json!({ "status": "ok" }))
}

fn press_key(params: &Value, windows: &[MacOSWindowInfo]) -> Result<Value> {
    let Some(window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
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
    let Some((key_code, flags)) = macos_key_chord(&keys) else {
        return Ok(failed_action("key or keys is required"));
    };
    activate_macos_window(&window)?;
    send_key(key_code as c_ushort, flags);
    Ok(json!({ "status": "ok" }))
}

fn guarded_text_action(
    params: &Value,
    windows: &[MacOSWindowInfo],
    action: fn(&Value, &MacOSWindowInfo) -> Result<Value>,
) -> Result<Value> {
    let Some(mut window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
    enrich_accessibility_text(&mut window);
    if macos_text_target_is_sensitive(&window, params) {
        return Ok(json!({
            "status": "blocked",
            "message": "sensitive fields require a dedicated secure credential flow"
        }));
    }
    action(params, &window)
}

fn type_text(params: &Value, window: &MacOSWindowInfo) -> Result<Value> {
    activate_macos_window(window)?;
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    send_text(text);
    Ok(json!({ "status": "ok" }))
}

fn set_value(params: &Value, window: &MacOSWindowInfo) -> Result<Value> {
    if params.get("elementId").is_some() || (params.get("x").is_some() && params.get("y").is_some())
    {
        match macos_resolve_action_point(window, params) {
            Ok((x, y)) => {
                activate_macos_window(window)?;
                move_mouse(x, y);
                click_mouse(x, y, false);
            }
            Err(result) => return Ok(result),
        }
    } else {
        activate_macos_window(window)?;
    }
    send_key(0, MACOS_EVENT_FLAG_MASK_COMMAND);
    let value = params
        .get("value")
        .and_then(Value::as_str)
        .unwrap_or_default();
    send_text(value);
    Ok(json!({ "status": "ok", "inputMode": "keyboard_fallback" }))
}

fn wait_for_state(params: &Value) -> Result<Value> {
    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(5_000)
        .min(30_000);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let windows = system_windows()?;
        let window = match params.get("windowId").and_then(Value::as_str) {
            Some(window_id) => find_macos_window(&windows, window_id),
            None => first_visible_user_window(&windows),
        };
        let Some(mut window) = window else {
            return Ok(stale_target());
        };
        enrich_accessibility_text(&mut window);
        let state = macos_wait_for_state_result(Some(window), params);
        if state.get("status").and_then(Value::as_str) != Some("timeout") {
            return Ok(state);
        }
        if Instant::now() >= deadline {
            return Ok(state);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn required_window(params: &Value, windows: &[MacOSWindowInfo]) -> Option<MacOSWindowInfo> {
    let window_id = params.get("windowId").and_then(Value::as_str)?;
    find_macos_window(windows, window_id)
}

fn numeric_param(params: &Value, name: &str) -> Option<i64> {
    params.get(name).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_f64().map(|value| value.round() as i64))
    })
}

fn activate_macos_window(window: &MacOSWindowInfo) -> Result<()> {
    unsafe {
        let app = AXUIElementCreateApplication(window.owner_pid as c_int);
        if app.is_null() {
            return Err(anyhow!("target application is unavailable"));
        }
        let target = matching_ax_window(app, window.window_id).or_else(|| first_ax_window(app));
        let Some(target) = target else {
            CFRelease(app as CFTypeRef);
            return Err(anyhow!("target window is unavailable"));
        };
        let raised = perform_ax_action(target, "AXRaise");
        CFRelease(target as CFTypeRef);
        CFRelease(app as CFTypeRef);
        if !raised {
            return Err(anyhow!("unable to activate target window"));
        }
    }
    Ok(())
}

fn move_mouse(x: i64, y: i64) {
    unsafe {
        let point = cg_point(x, y);
        let _ = CGWarpMouseCursorPosition(point);
        post_mouse_event(K_CG_EVENT_MOUSE_MOVED, point, K_CG_MOUSE_BUTTON_LEFT);
    }
}

fn click_mouse(x: i64, y: i64, secondary: bool) {
    unsafe {
        let point = cg_point(x, y);
        let (down, up, button) = if secondary {
            (
                K_CG_EVENT_RIGHT_MOUSE_DOWN,
                K_CG_EVENT_RIGHT_MOUSE_UP,
                K_CG_MOUSE_BUTTON_RIGHT,
            )
        } else {
            (
                K_CG_EVENT_LEFT_MOUSE_DOWN,
                K_CG_EVENT_LEFT_MOUSE_UP,
                K_CG_MOUSE_BUTTON_LEFT,
            )
        };
        post_mouse_event(down, point, button);
        post_mouse_event(up, point, button);
    }
}

fn drag_mouse(from_x: i64, from_y: i64, to_x: i64, to_y: i64) {
    unsafe {
        let from = cg_point(from_x, from_y);
        let to = cg_point(to_x, to_y);
        post_mouse_event(K_CG_EVENT_LEFT_MOUSE_DOWN, from, K_CG_MOUSE_BUTTON_LEFT);
        post_mouse_event(K_CG_EVENT_LEFT_MOUSE_DRAGGED, to, K_CG_MOUSE_BUTTON_LEFT);
        post_mouse_event(K_CG_EVENT_LEFT_MOUSE_UP, to, K_CG_MOUSE_BUTTON_LEFT);
    }
}

fn scroll_mouse(delta_y: c_int) {
    unsafe {
        let event =
            CGEventCreateScrollWheelEvent(ptr::null(), K_CG_SCROLL_EVENT_UNIT_PIXEL, 1, delta_y);
        post_event(event);
    }
}

fn send_text(text: &str) {
    for unit in text.encode_utf16() {
        unsafe {
            let down = CGEventCreateKeyboardEvent(ptr::null(), 0, true);
            if !down.is_null() {
                CGEventKeyboardSetUnicodeString(down, 1, &unit);
            }
            post_event(down);
            let up = CGEventCreateKeyboardEvent(ptr::null(), 0, false);
            if !up.is_null() {
                CGEventKeyboardSetUnicodeString(up, 1, &unit);
            }
            post_event(up);
        }
    }
}

fn send_key(key_code: c_ushort, flags: u64) {
    unsafe {
        let down = CGEventCreateKeyboardEvent(ptr::null(), key_code, true);
        if !down.is_null() {
            CGEventSetFlags(down, flags);
        }
        post_event(down);
        let up = CGEventCreateKeyboardEvent(ptr::null(), key_code, false);
        if !up.is_null() {
            CGEventSetFlags(up, flags);
        }
        post_event(up);
    }
}

unsafe fn post_mouse_event(event_type: c_uint, point: CGPoint, button: c_uint) {
    let event = CGEventCreateMouseEvent(ptr::null(), event_type, point, button);
    post_event(event);
}

unsafe fn post_event(event: CGEventRef) {
    if event.is_null() {
        return;
    }
    CGEventPost(K_CG_HID_EVENT_TAP, event);
    CFRelease(event as CFTypeRef);
}

fn cg_point(x: i64, y: i64) -> CGPoint {
    CGPoint {
        x: x as c_double,
        y: y as c_double,
    }
}

struct MacOSPermissionState {
    accessibility: bool,
    screen_recording: bool,
}

impl MacOSPermissionState {
    fn all_granted(&self) -> bool {
        self.accessibility && self.screen_recording
    }
}

fn permission_state() -> MacOSPermissionState {
    MacOSPermissionState {
        accessibility: ax_is_process_trusted(),
        screen_recording: cg_preflight_screen_capture_access(),
    }
}

fn request_permissions(permissions: MacOSPermissionState) -> Value {
    if !permissions.accessibility {
        request_accessibility_prompt();
        open_permission_settings(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        );
    } else if !permissions.screen_recording {
        request_screen_capture_access();
        open_permission_settings(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        );
    }
    let updated = permission_state();
    desktop_permission_diagnostics(
        Some(updated.accessibility),
        Some(updated.screen_recording),
        Some("macOS permission request was started for Lume Computer Use.app".to_owned()),
    )
}

fn ax_is_process_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

fn cg_preflight_screen_capture_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

fn request_accessibility_prompt() -> bool {
    unsafe {
        let Ok(key) = CString::new("AXTrustedCheckOptionPrompt") else {
            return AXIsProcessTrusted() != 0;
        };
        let key_ref =
            CFStringCreateWithCString(ptr::null(), key.as_ptr(), K_CF_STRING_ENCODING_UTF8);
        if key_ref.is_null() {
            return AXIsProcessTrusted() != 0;
        }
        let keys = [key_ref as CFTypeRef];
        let values = [kCFBooleanTrue as CFTypeRef];
        let options = CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            ptr::null(),
            ptr::null(),
        );
        let trusted = if options.is_null() {
            AXIsProcessTrusted() != 0
        } else {
            let trusted = AXIsProcessTrustedWithOptions(options) != 0;
            CFRelease(options as CFTypeRef);
            trusted
        };
        CFRelease(key_ref as CFTypeRef);
        trusted
    }
}

fn request_screen_capture_access() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

fn open_permission_settings(settings_url: &str) {
    let _ = Command::new("/usr/bin/open").arg(settings_url).spawn();
}

fn enrich_accessibility_text(window: &mut MacOSWindowInfo) {
    unsafe {
        let app = AXUIElementCreateApplication(window.owner_pid as c_int);
        if app.is_null() {
            return;
        }
        let root = copy_ax_attribute(app, "AXFocusedWindow").or_else(|| first_ax_window(app));
        if let Some(root) = root {
            let text = collect_ax_text(root);
            if !text.document_text.is_empty() {
                window.document_text = Some(text.document_text);
            }
            if let Some(selected_text) = text.selected_text {
                window.selected_text = Some(selected_text);
            }
            window.elements = text.elements;
            CFRelease(root as CFTypeRef);
        }
        CFRelease(app as CFTypeRef);
    }
}

struct AxTextSnapshot {
    document_text: String,
    selected_text: Option<String>,
    elements: Vec<MacOSElementInfo>,
}

unsafe fn collect_ax_text(root: AXUIElementRef) -> AxTextSnapshot {
    let mut lines = Vec::<String>::new();
    let mut selected_text = None;
    let mut remaining = 500usize;
    let elements = collect_ax_children(root, 0, &mut remaining, &mut lines, &mut selected_text);
    AxTextSnapshot {
        document_text: lines.join("\n"),
        selected_text,
        elements,
    }
}

unsafe fn collect_ax_children(
    parent: AXUIElementRef,
    depth: usize,
    remaining: &mut usize,
    lines: &mut Vec<String>,
    selected_text: &mut Option<String>,
) -> Vec<MacOSElementInfo> {
    let Some(children) = copy_ax_attribute(parent, "AXChildren") else {
        return Vec::new();
    };
    let mut output = Vec::new();
    if cf_type_matches(children as CFTypeRef, CFArrayGetTypeID()) {
        let count = CFArrayGetCount(children as CFArrayRef);
        for index in 0..count {
            let child = CFArrayGetValueAtIndex(children as CFArrayRef, index) as AXUIElementRef;
            if child.is_null() {
                continue;
            }
            if let Some(element) =
                collect_ax_element(child, depth + 1, remaining, lines, selected_text)
            {
                output.push(element);
            }
            if *remaining == 0 {
                break;
            }
        }
    }
    CFRelease(children as CFTypeRef);
    output
}

unsafe fn collect_ax_element(
    element: AXUIElementRef,
    depth: usize,
    remaining: &mut usize,
    lines: &mut Vec<String>,
    selected_text: &mut Option<String>,
) -> Option<MacOSElementInfo> {
    if depth >= 12 || *remaining == 0 {
        return None;
    }
    let role =
        copy_ax_string_attribute(element, "AXRole").unwrap_or_else(|| "AXUnknown".to_owned());
    let title = copy_ax_string_attribute(element, "AXTitle")
        .or_else(|| copy_ax_string_attribute(element, "AXDescription"))
        .unwrap_or_default();
    let value = copy_ax_string_attribute(element, "AXValue").unwrap_or_default();
    let sensitive = role == "AXSecureTextField"
        || copy_ax_bool_attribute(element, "AXProtectedContent") == Some(true);
    if selected_text.is_none() {
        if let Some(text) = copy_ax_string_attribute(element, "AXSelectedText") {
            if !sensitive {
                push_text(lines, &text);
            }
            *selected_text = Some(text);
        }
    }
    if !sensitive {
        push_text(lines, &title);
        push_text(lines, &value);
    }
    *remaining -= 1;
    let (x, y) = copy_ax_point_attribute(element, "AXPosition").unwrap_or((0.0, 0.0));
    let (width, height) = copy_ax_size_attribute(element, "AXSize").unwrap_or((0.0, 0.0));
    let children = collect_ax_children(element, depth, remaining, lines, selected_text);
    Some(MacOSElementInfo {
        role,
        title,
        value,
        x,
        y,
        width,
        height,
        enabled: copy_ax_bool_attribute(element, "AXEnabled").unwrap_or(true),
        focused: copy_ax_bool_attribute(element, "AXFocused").unwrap_or(false),
        sensitive,
        children,
    })
}

fn push_text(lines: &mut Vec<String>, text: &str) {
    let normalized = text.trim();
    if normalized.is_empty() || lines.iter().any(|line| line == normalized) {
        return;
    }
    lines.push(normalized.to_owned());
}

unsafe fn first_ax_window(app: AXUIElementRef) -> Option<AXUIElementRef> {
    let windows = copy_ax_attribute(app, "AXWindows")?;
    if !cf_type_matches(windows as CFTypeRef, CFArrayGetTypeID())
        || CFArrayGetCount(windows as CFArrayRef) == 0
    {
        CFRelease(windows as CFTypeRef);
        return None;
    }
    let first = CFArrayGetValueAtIndex(windows as CFArrayRef, 0);
    let retained = if first.is_null() {
        ptr::null()
    } else {
        CFRetain(first)
    };
    CFRelease(windows as CFTypeRef);
    (!retained.is_null()).then_some(retained as AXUIElementRef)
}

unsafe fn matching_ax_window(app: AXUIElementRef, window_id: u64) -> Option<AXUIElementRef> {
    let windows = copy_ax_attribute(app, "AXWindows")?;
    if !cf_type_matches(windows as CFTypeRef, CFArrayGetTypeID()) {
        CFRelease(windows as CFTypeRef);
        return None;
    }
    let count = CFArrayGetCount(windows as CFArrayRef);
    for index in 0..count {
        let child = CFArrayGetValueAtIndex(windows as CFArrayRef, index) as AXUIElementRef;
        if child.is_null() {
            continue;
        }
        if copy_ax_i64_attribute(child, "AXWindowNumber") == Some(window_id as i64) {
            let retained = CFRetain(child as CFTypeRef);
            CFRelease(windows as CFTypeRef);
            return (!retained.is_null()).then_some(retained as AXUIElementRef);
        }
    }
    CFRelease(windows as CFTypeRef);
    None
}

unsafe fn matching_ax_element_by_id(
    root: AXUIElementRef,
    element_id: &str,
) -> Option<AXUIElementRef> {
    let path = element_id.strip_prefix("root.")?;
    let retained_root = CFRetain(root as CFTypeRef);
    if retained_root.is_null() {
        return None;
    }
    let mut current = retained_root as AXUIElementRef;
    for part in path.split('.') {
        let Ok(index) = part.parse::<usize>() else {
            CFRelease(current as CFTypeRef);
            return None;
        };
        let child = copy_ax_child_by_index(current, index);
        CFRelease(current as CFTypeRef);
        let Some(child) = child else {
            return None;
        };
        current = child;
    }
    Some(current)
}

unsafe fn copy_ax_child_by_index(parent: AXUIElementRef, index: usize) -> Option<AXUIElementRef> {
    let children = copy_ax_attribute(parent, "AXChildren")?;
    if !cf_type_matches(children as CFTypeRef, CFArrayGetTypeID()) {
        CFRelease(children as CFTypeRef);
        return None;
    }
    let count = CFArrayGetCount(children as CFArrayRef);
    if index >= count as usize {
        CFRelease(children as CFTypeRef);
        return None;
    }
    let child = CFArrayGetValueAtIndex(children as CFArrayRef, index as CFIndex);
    let retained = if child.is_null() {
        ptr::null()
    } else {
        CFRetain(child)
    };
    CFRelease(children as CFTypeRef);
    (!retained.is_null()).then_some(retained as AXUIElementRef)
}

unsafe fn perform_ax_action(element: AXUIElementRef, action: &str) -> bool {
    let Ok(action) = CString::new(action) else {
        return false;
    };
    let action_ref =
        CFStringCreateWithCString(ptr::null(), action.as_ptr(), K_CF_STRING_ENCODING_UTF8);
    if action_ref.is_null() {
        return false;
    }
    let result = AXUIElementPerformAction(element, action_ref) == K_AX_ERROR_SUCCESS;
    CFRelease(action_ref as CFTypeRef);
    result
}

unsafe fn copy_ax_string_attribute(element: AXUIElementRef, attribute: &str) -> Option<String> {
    let value = copy_ax_attribute(element, attribute)?;
    let text = if cf_type_matches(value, CFStringGetTypeID()) {
        cf_string_to_string(value as CFStringRef)
    } else {
        None
    };
    CFRelease(value);
    text
}

unsafe fn copy_ax_bool_attribute(element: AXUIElementRef, attribute: &str) -> Option<bool> {
    let value = copy_ax_attribute(element, attribute)?;
    let output = if cf_type_matches(value, CFBooleanGetTypeID()) {
        Some(CFBooleanGetValue(value as CFBooleanRef) != 0)
    } else {
        None
    };
    CFRelease(value);
    output
}

unsafe fn copy_ax_i64_attribute(element: AXUIElementRef, attribute: &str) -> Option<i64> {
    let value = copy_ax_attribute(element, attribute)?;
    let mut output = 0_i64;
    let result = if cf_type_matches(value, CFNumberGetTypeID()) {
        (CFNumberGetValue(
            value as CFNumberRef,
            K_CF_NUMBER_SINT64_TYPE,
            (&mut output as *mut i64).cast(),
        ) != 0)
            .then_some(output)
    } else {
        None
    };
    CFRelease(value);
    result
}

unsafe fn copy_ax_point_attribute(element: AXUIElementRef, attribute: &str) -> Option<(f64, f64)> {
    let value = copy_ax_attribute(element, attribute)?;
    let mut point = CGPoint { x: 0.0, y: 0.0 };
    let output = if AXValueGetValue(
        value as AXValueRef,
        K_AX_VALUE_CGPOINT_TYPE,
        (&mut point as *mut CGPoint).cast(),
    ) != 0
    {
        Some((point.x, point.y))
    } else {
        None
    };
    CFRelease(value);
    output
}

unsafe fn copy_ax_size_attribute(element: AXUIElementRef, attribute: &str) -> Option<(f64, f64)> {
    let value = copy_ax_attribute(element, attribute)?;
    let mut size = CGSize {
        width: 0.0,
        height: 0.0,
    };
    let output = if AXValueGetValue(
        value as AXValueRef,
        K_AX_VALUE_CGSIZE_TYPE,
        (&mut size as *mut CGSize).cast(),
    ) != 0
    {
        Some((size.width, size.height))
    } else {
        None
    };
    CFRelease(value);
    output
}

unsafe fn copy_ax_attribute(element: AXUIElementRef, attribute: &str) -> Option<CFTypeRef> {
    let Ok(attribute) = CString::new(attribute) else {
        return None;
    };
    let attribute_ref =
        CFStringCreateWithCString(ptr::null(), attribute.as_ptr(), K_CF_STRING_ENCODING_UTF8);
    if attribute_ref.is_null() {
        return None;
    }
    let mut value = ptr::null();
    let error = AXUIElementCopyAttributeValue(element, attribute_ref, &mut value);
    CFRelease(attribute_ref as CFTypeRef);
    (error == K_AX_ERROR_SUCCESS && !value.is_null()).then_some(value)
}

unsafe fn cf_type_matches(value: CFTypeRef, expected: CFTypeID) -> bool {
    !value.is_null() && CFGetTypeID(value) == expected
}

fn system_windows() -> Result<Vec<MacOSWindowInfo>> {
    let array = unsafe {
        CGWindowListCopyWindowInfo(
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            0,
        )
    };
    if array.is_null() {
        return Err(anyhow!("CGWindowListCopyWindowInfo returned null"));
    }
    let mut windows = Vec::new();
    let mut focused_assigned = false;
    unsafe {
        let count = CFArrayGetCount(array);
        for index in 0..count {
            let dict = CFArrayGetValueAtIndex(array, index) as CFDictionaryRef;
            if dict.is_null() {
                continue;
            }
            let bounds = cf_dictionary_value(dict, "kCGWindowBounds") as CFDictionaryRef;
            if bounds.is_null() {
                continue;
            }
            let mut window = MacOSWindowInfo {
                window_id: cf_dictionary_i64(dict, "kCGWindowNumber").unwrap_or_default() as u64,
                owner_pid: cf_dictionary_i64(dict, "kCGWindowOwnerPID").unwrap_or_default() as u32,
                owner_name: cf_dictionary_string(dict, "kCGWindowOwnerName").unwrap_or_default(),
                title: cf_dictionary_string(dict, "kCGWindowName").unwrap_or_default(),
                x: cf_dictionary_f64(bounds, "X").unwrap_or_default(),
                y: cf_dictionary_f64(bounds, "Y").unwrap_or_default(),
                width: cf_dictionary_f64(bounds, "Width").unwrap_or_default(),
                height: cf_dictionary_f64(bounds, "Height").unwrap_or_default(),
                layer: cf_dictionary_i64(dict, "kCGWindowLayer").unwrap_or_default(),
                is_onscreen: cf_dictionary_bool(dict, "kCGWindowIsOnscreen").unwrap_or(true),
                is_focused: false,
                document_text: None,
                selected_text: None,
                elements: vec![],
            };
            if !focused_assigned && is_focus_candidate(&window) {
                window.is_focused = true;
                focused_assigned = true;
            }
            windows.push(window);
        }
        CFRelease(array as CFTypeRef);
    }
    Ok(windows)
}

fn is_focus_candidate(window: &MacOSWindowInfo) -> bool {
    window.is_onscreen
        && window.layer == 0
        && window.width > 0.0
        && window.height > 0.0
        && (!window.owner_name.trim().is_empty() || !window.title.trim().is_empty())
}

unsafe fn cf_dictionary_value(dict: CFDictionaryRef, key: &str) -> CFTypeRef {
    let Ok(key) = CString::new(key) else {
        return ptr::null();
    };
    let key_ref = CFStringCreateWithCString(ptr::null(), key.as_ptr(), K_CF_STRING_ENCODING_UTF8);
    if key_ref.is_null() {
        return ptr::null();
    }
    let mut value = ptr::null();
    let found = CFDictionaryGetValueIfPresent(dict, key_ref as CFTypeRef, &mut value);
    CFRelease(key_ref as CFTypeRef);
    if found == 0 {
        return ptr::null();
    }
    value
}

unsafe fn cf_dictionary_string(dict: CFDictionaryRef, key: &str) -> Option<String> {
    let value = cf_dictionary_value(dict, key) as CFStringRef;
    if value.is_null() {
        return None;
    }
    cf_string_to_string(value)
}

unsafe fn cf_dictionary_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
    let value = cf_dictionary_value(dict, key) as CFNumberRef;
    if value.is_null() {
        return None;
    }
    let mut output = 0_i64;
    (CFNumberGetValue(
        value,
        K_CF_NUMBER_SINT64_TYPE,
        (&mut output as *mut i64).cast(),
    ) != 0)
        .then_some(output)
}

unsafe fn cf_dictionary_f64(dict: CFDictionaryRef, key: &str) -> Option<f64> {
    let value = cf_dictionary_value(dict, key) as CFNumberRef;
    if value.is_null() {
        return None;
    }
    let mut output = 0.0_f64;
    (CFNumberGetValue(
        value,
        K_CF_NUMBER_DOUBLE_TYPE,
        (&mut output as *mut f64).cast(),
    ) != 0)
        .then_some(output)
}

unsafe fn cf_dictionary_bool(dict: CFDictionaryRef, key: &str) -> Option<bool> {
    let value = cf_dictionary_value(dict, key) as CFBooleanRef;
    if value.is_null() {
        return None;
    }
    Some(CFBooleanGetValue(value) != 0)
}

unsafe fn cf_string_to_string(value: CFStringRef) -> Option<String> {
    let mut buffer = vec![0 as c_char; 4096];
    let ok = CFStringGetCString(
        value,
        buffer.as_mut_ptr(),
        buffer.len() as c_long,
        K_CF_STRING_ENCODING_UTF8,
    );
    if ok == 0 {
        return None;
    }
    CStr::from_ptr(buffer.as_ptr())
        .to_str()
        .ok()
        .map(str::to_owned)
}

fn stale_target() -> Value {
    json!({ "status": "stale_target", "message": "target window is unavailable" })
}

fn failed_action(message: &str) -> Value {
    json!({ "status": "failed", "message": message })
}

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFNumberRef = *const c_void;
type CFBooleanRef = *const c_void;
type CFArrayRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFIndex = c_long;
type CFTypeID = c_ulong;
type AXUIElementRef = *const c_void;
type AXValueRef = *const c_void;
type CGEventRef = *const c_void;
type CGEventSourceRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: c_double,
    y: c_double,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: c_double,
    height: c_double,
}

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_CF_NUMBER_SINT64_TYPE: c_int = 4;
const K_CF_NUMBER_DOUBLE_TYPE: c_int = 13;
const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: c_uint = 1;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: c_uint = 16;
const K_CG_HID_EVENT_TAP: c_uint = 0;
const K_CG_EVENT_LEFT_MOUSE_DOWN: c_uint = 1;
const K_CG_EVENT_LEFT_MOUSE_UP: c_uint = 2;
const K_CG_EVENT_RIGHT_MOUSE_DOWN: c_uint = 3;
const K_CG_EVENT_RIGHT_MOUSE_UP: c_uint = 4;
const K_CG_EVENT_MOUSE_MOVED: c_uint = 5;
const K_CG_EVENT_LEFT_MOUSE_DRAGGED: c_uint = 6;
const K_CG_MOUSE_BUTTON_LEFT: c_uint = 0;
const K_CG_MOUSE_BUTTON_RIGHT: c_uint = 1;
const K_CG_SCROLL_EVENT_UNIT_PIXEL: c_uint = 0;
const K_AX_ERROR_SUCCESS: c_int = 0;
const K_AX_VALUE_CGPOINT_TYPE: c_int = 1;
const K_AX_VALUE_CGSIZE_TYPE: c_int = 2;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> c_uchar;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> c_uchar;
    fn AXUIElementCreateApplication(pid: c_int) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> c_int;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> c_int;
    fn AXValueGetValue(value: AXValueRef, value_type: c_int, output: *mut c_void) -> c_uchar;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGWindowListCopyWindowInfo(option: c_uint, relative_to_window: c_uint) -> CFArrayRef;
    fn CGWarpMouseCursorPosition(new_cursor_position: CGPoint) -> c_int;
    fn CGEventCreateMouseEvent(
        source: CGEventSourceRef,
        mouse_type: c_uint,
        mouse_cursor_position: CGPoint,
        mouse_button: c_uint,
    ) -> CGEventRef;
    fn CGEventCreateKeyboardEvent(
        source: CGEventSourceRef,
        virtual_key: c_ushort,
        key_down: bool,
    ) -> CGEventRef;
    fn CGEventCreateScrollWheelEvent(
        source: CGEventSourceRef,
        units: c_uint,
        wheel_count: c_uint,
        wheel1: c_int,
        ...
    ) -> CGEventRef;
    fn CGEventKeyboardSetUnicodeString(
        event: CGEventRef,
        string_length: c_ulong,
        unicode_string: *const u16,
    );
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventPost(tap: c_uint, event: CGEventRef);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
    fn CFStringGetTypeID() -> CFTypeID;
    fn CFBooleanGetTypeID() -> CFTypeID;
    fn CFNumberGetTypeID() -> CFTypeID;
    fn CFArrayGetTypeID() -> CFTypeID;
    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, index: CFIndex) -> CFTypeRef;
    fn CFDictionaryGetValueIfPresent(
        dict: CFDictionaryRef,
        key: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> c_uchar;
    fn CFDictionaryCreate(
        alloc: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        num_values: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFDictionaryRef;
    fn CFStringCreateWithCString(
        alloc: CFTypeRef,
        c_str: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFStringGetCString(
        string: CFStringRef,
        buffer: *mut c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> c_uchar;
    fn CFNumberGetValue(number: CFNumberRef, number_type: c_int, value: *mut c_void) -> c_uchar;
    fn CFBooleanGetValue(boolean: CFBooleanRef) -> c_uchar;
    static kCFBooleanTrue: CFBooleanRef;
}
