use crate::{
    desktop_permission_diagnostics,
    macos_snapshot::{
        find_macos_window, first_visible_user_window, macos_current_context_result,
        macos_get_window_result, macos_get_window_state_result, macos_list_apps_result,
        macos_list_windows_result, MacOSElementInfo, MacOSWindowInfo,
    },
    DesktopBackend,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{
    ffi::{CStr, CString},
    os::raw::{c_char, c_double, c_int, c_long, c_uchar, c_uint, c_ulong, c_void},
    process::Command,
    ptr,
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
            _ => Ok(json!({
                "status": "unavailable",
                "message": format!("desktop method is not implemented on macOS yet: {method}")
            })),
        }
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

#[repr(C)]
struct CGPoint {
    x: c_double,
    y: c_double,
}

#[repr(C)]
struct CGSize {
    width: c_double,
    height: c_double,
}

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_CF_NUMBER_SINT64_TYPE: c_int = 4;
const K_CF_NUMBER_DOUBLE_TYPE: c_int = 13;
const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: c_uint = 1;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: c_uint = 16;
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
    fn AXValueGetValue(value: AXValueRef, value_type: c_int, output: *mut c_void) -> c_uchar;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGWindowListCopyWindowInfo(option: c_uint, relative_to_window: c_uint) -> CFArrayRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
    fn CFStringGetTypeID() -> CFTypeID;
    fn CFBooleanGetTypeID() -> CFTypeID;
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
