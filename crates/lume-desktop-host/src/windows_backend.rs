use std::{
    collections::BTreeMap, ffi::c_void, mem::size_of, path::Path, process::Command, thread,
    time::Duration,
};

use crate::windows_capture::capture_window_bgra;
use crate::windows_cursor_motion::spring_close_enough_time_seconds;
use crate::windows_overlay::{
    move_visual_cursor, pulse_visual_cursor, settle_visual_cursor, VISUAL_CURSOR_WINDOW_TITLE,
};
use crate::{
    desktop_click_options, desktop_drag_points, desktop_scroll_options, DesktopBackend,
    DesktopMouseButton, DesktopScrollDirection, DesktopScrollOptions,
};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use windows::{
    core::{Interface, BOOL, BSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT, WPARAM},
        Graphics::{
            Gdi::{
                BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
                GetDIBits, ReleaseDC, ScreenToClient, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
                BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
            },
            Imaging::{
                CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGR,
                IWICBitmapFrameEncode, IWICImagingFactory, WICBitmapEncoderNoCache,
            },
        },
        Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
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
                IUIAutomationScrollItemPattern, IUIAutomationScrollPattern,
                IUIAutomationSelectionItemPattern, IUIAutomationTextPattern,
                IUIAutomationTogglePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
                ScrollAmount, ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement,
                ScrollAmount_NoAmount, UIA_ButtonControlTypeId, UIA_DocumentControlTypeId,
                UIA_EditControlTypeId, UIA_ExpandCollapsePatternId, UIA_GroupControlTypeId,
                UIA_InvokePatternId, UIA_ListControlTypeId, UIA_ListItemControlTypeId,
                UIA_MenuItemControlTypeId, UIA_PaneControlTypeId, UIA_ScrollItemPatternId,
                UIA_ScrollPatternId, UIA_SelectionItemPatternId, UIA_TabItemControlTypeId,
                UIA_TextControlTypeId, UIA_TextPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
                UIA_WindowControlTypeId, UIA_CONTROLTYPE_ID,
            },
            Input::KeyboardAndMouse::{
                VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME,
                VK_LEFT, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_TAB, VK_UP,
            },
            WindowsAndMessaging::{
                BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindowRect,
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow,
                IsIconic, IsWindow, IsWindowVisible, PostMessageW, SendMessageW,
                SetForegroundWindow, ShowWindow, PW_RENDERFULLCONTENT, SW_RESTORE, WM_CHAR,
                WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
                WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
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
            "current_context" => current_context(params),
            "launch_app" => launch_app(params),
            "activate_window" => with_window(params, |hwnd| activate(hwnd)),
            "move_pointer" => move_pointer(params),
            "click" => click(params),
            "perform_secondary_action" => perform_secondary_action(params),
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
    let revision = window_revision(&window);
    let screenshots = screenshot_refs(
        hwnd,
        &window,
        params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
    );
    let accessibility = accessibility_state(hwnd)
        .unwrap_or_else(|error| fallback_accessibility_state(title, Some(error.to_string())));
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
    );
    let visible_text = accessibility
        .get("documentText")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| window["title"].as_str().unwrap_or_default());
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
        "visibleText": visible_text,
        "screenshotId": screenshot_id(&window),
        "screenshots": screenshots,
        "untrusted": true,
    });
    if let Some(selected_text) = selected_text {
        snapshot["selectedText"] = Value::String(selected_text.to_owned());
    }
    Ok(json!({
        "status": "ok",
        "snapshot": snapshot,
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
        "mimeType": "image/png",
    });
    if include_pixels {
        match capture_window_png_data_url(hwnd, width, height) {
            Ok(capture) => {
                screenshot["dataUrl"] = Value::String(capture.data_url);
                screenshot["captureMode"] = Value::String(capture.mode.to_owned());
                screenshot["width"] = json!(capture.width);
                screenshot["height"] = json!(capture.height);
                if let Some(reason) = capture.fallback_reason {
                    screenshot["captureFallbackReason"] = Value::String(reason);
                }
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

struct WindowCapture {
    data_url: String,
    mode: &'static str,
    fallback_reason: Option<String>,
    width: u32,
    height: u32,
}

fn capture_window_png_data_url(hwnd: HWND, width: i32, height: i32) -> Result<WindowCapture> {
    let graphics_capture =
        capture_window_bgra(hwnd, Duration::from_millis(1500)).and_then(|capture| {
            encode_bgra_png_data_url(&capture.pixels, capture.width, capture.height).map(
                |data_url| WindowCapture {
                    data_url,
                    mode: "windows_graphics_capture",
                    fallback_reason: None,
                    width: capture.width,
                    height: capture.height,
                },
            )
        });
    let graphics_capture_error = match graphics_capture {
        Ok(capture) => return Ok(capture),
        Err(error) => error,
    };
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
    let print_capture = if unsafe { IsHungAppWindow(hwnd).as_bool() } {
        Err(anyhow!("target window is not responding"))
    } else {
        let print_result =
            unsafe { PrintWindow(hwnd, memory_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)) };
        if print_result.as_bool() {
            bitmap_to_png_data_url(memory_dc, bitmap, width, height, true)
        } else {
            Err(anyhow!("PrintWindow returned no pixels"))
        }
    };
    let result = match print_capture {
        Ok(data_url) => Ok(WindowCapture {
            data_url,
            mode: "print_window",
            fallback_reason: Some(graphics_capture_error.to_string()),
            width: width as u32,
            height: height as u32,
        }),
        Err(print_error) => unsafe {
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
            .map_err(|error| anyhow!("window capture failed: {error}"))
            .and_then(|_| bitmap_to_png_data_url(memory_dc, bitmap, width, height, false))
            .map(|data_url| WindowCapture {
                data_url,
                mode: "screen_bitblt",
                fallback_reason: Some(format!(
                    "Windows.Graphics.Capture failed: {graphics_capture_error}; PrintWindow failed: {print_error}"
                )),
                width: width as u32,
                height: height as u32,
            })
        },
    };
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

fn bitmap_to_png_data_url(
    memory_dc: windows::Win32::Graphics::Gdi::HDC,
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    width: i32,
    height: i32,
    reject_empty: bool,
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
    if reject_empty && !pixels_have_visible_content(&pixels) {
        return Err(anyhow!("PrintWindow returned empty pixels"));
    }
    encode_bgra_png_data_url(&pixels, width as u32, height as u32)
}

fn encode_bgra_png_data_url(pixels: &[u8], width: u32, height: u32) -> Result<String> {
    let expected_bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixel_count| pixel_count.checked_mul(4))
        .ok_or_else(|| anyhow!("window capture dimensions are too large"))?;
    if pixels.len() != expected_bytes {
        return Err(anyhow!("window capture returned an invalid pixel buffer"));
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
        let mut pixel_format = GUID_WICPixelFormat32bppBGR;
        frame.SetPixelFormat(&mut pixel_format)?;
        frame.WritePixels(height, width * 4, pixels)?;
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

fn pixels_have_visible_content(pixels: &[u8]) -> bool {
    pixels
        .chunks_exact(4)
        .any(|pixel| pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0)
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
        result.push(node);
        index += 1;
        child = unsafe { walker.GetNextSiblingElement(&element) }.ok();
    }
    result
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
        let attached_threads =
            activation_thread_ids(current_thread, foreground_thread, target_thread);
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
    let Some(target) = target_window(params) else {
        return Ok(stale_target());
    };
    let (x, y) = action_point(params)?;
    animate_visual_pointer(x, y, Some(target));
    post_targeted_pointer_move(target, (x, y))?;
    Ok(json!({
        "status": "ok",
        "inputMode": preferred_pointer_move_injection()
    }))
}

fn post_targeted_pointer_move(hwnd: HWND, point: (i32, i32)) -> Result<()> {
    let point = screen_to_client_point(hwnd, point)?;
    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_MOUSEMOVE,
            WPARAM(0),
            windows_point_lparam(point.x, point.y),
        )?;
    }
    Ok(())
}

fn click(params: &Value) -> Result<Value> {
    let options = match desktop_click_options(params, false) {
        Ok(options) => options,
        Err(message) => return Ok(json!({ "status": "failed", "message": message })),
    };
    let Some(target) = target_window(params) else {
        return Ok(stale_target());
    };
    let semantic = preferred_pointer_injection(params, options.button) == "uia";
    let point = action_point(params)?;
    animate_visual_pointer(point.0, point.1, Some(target));
    if semantic {
        if let Some(input_mode) = try_preferred_element_click(params, options.count)? {
            pulse_visual_cursor(point.0, point.1, Some(target));
            return Ok(json!({ "status": "ok", "inputMode": input_mode }));
        }
    }
    post_targeted_click(target, point, options)?;
    pulse_visual_cursor(point.0, point.1, Some(target));
    Ok(json!({ "status": "ok", "inputMode": "targeted_window_message" }))
}

fn post_targeted_click(
    hwnd: HWND,
    point: (i32, i32),
    options: crate::DesktopClickOptions,
) -> Result<()> {
    let point = screen_to_client_point(hwnd, point)?;
    let lparam = windows_point_lparam(point.x, point.y);
    let (down, up, down_state) = windows_button_message_spec(options.button);
    for index in 0..options.count {
        unsafe {
            PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(0), lparam)?;
            PostMessageW(Some(hwnd), down, WPARAM(down_state), lparam)?;
        }
        thread::sleep(Duration::from_millis(35));
        unsafe {
            PostMessageW(Some(hwnd), up, WPARAM(0), lparam)?;
        }
        if index + 1 < options.count {
            thread::sleep(Duration::from_millis(50));
        }
    }
    Ok(())
}

fn perform_secondary_action(params: &Value) -> Result<Value> {
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
    let options = match desktop_scroll_options(params) {
        Ok(options) => options,
        Err(message) => return Ok(failed_action(message)),
    };
    let Some(hwnd) = target_window(params) else {
        return Ok(stale_target());
    };
    let Some(element) = resolve_element(params)? else {
        return Ok(json!({
            "status": "stale_target",
            "message": "target element is unavailable",
        }));
    };
    let bounds = unsafe { element.CurrentBoundingRectangle().ok() };
    if try_scroll_element(&element, options)? {
        if let Some(bounds) = bounds {
            settle_visual_cursor(
                (bounds.left + bounds.right) / 2,
                (bounds.top + bounds.bottom) / 2,
                Some(hwnd),
            );
        }
        return Ok(json!({ "status": "ok", "inputMode": "uia_scroll" }));
    }
    let Some(bounds) = bounds else {
        return Ok(failed_action("target element has no scrollable bounds"));
    };
    let point = (
        (bounds.left + bounds.right) / 2,
        (bounds.top + bounds.bottom) / 2,
    );
    settle_visual_cursor(point.0, point.1, Some(hwnd));
    post_targeted_scroll(hwnd, point, options)?;
    Ok(json!({ "status": "ok", "inputMode": "targeted_window_message" }))
}

fn try_scroll_element(
    element: &IUIAutomationElement,
    options: DesktopScrollOptions,
) -> Result<bool> {
    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) };
    let Ok(pattern) = pattern else {
        return Ok(false);
    };
    let (horizontal, vertical) = windows_scroll_amounts(options.direction);
    let repeat_count = windows_scroll_repeat_count(options.pages);
    for index in 0..repeat_count {
        unsafe { pattern.Scroll(horizontal, vertical)? };
        if index + 1 < repeat_count {
            thread::sleep(Duration::from_millis(40));
        }
    }
    Ok(true)
}

fn post_targeted_scroll(
    hwnd: HWND,
    point: (i32, i32),
    options: DesktopScrollOptions,
) -> Result<()> {
    let (message, delta) = windows_scroll_message_and_delta(options.direction, options.pages);
    unsafe {
        PostMessageW(
            Some(hwnd),
            message,
            windows_wheel_wparam(delta),
            windows_point_lparam(point.0, point.1),
        )?;
    }
    Ok(())
}

fn windows_scroll_amounts(direction: DesktopScrollDirection) -> (ScrollAmount, ScrollAmount) {
    match direction {
        DesktopScrollDirection::Up => (ScrollAmount_NoAmount, ScrollAmount_LargeDecrement),
        DesktopScrollDirection::Down => (ScrollAmount_NoAmount, ScrollAmount_LargeIncrement),
        DesktopScrollDirection::Left => (ScrollAmount_LargeDecrement, ScrollAmount_NoAmount),
        DesktopScrollDirection::Right => (ScrollAmount_LargeIncrement, ScrollAmount_NoAmount),
    }
}

fn windows_scroll_repeat_count(pages: f64) -> u32 {
    pages.ceil().clamp(1.0, u32::MAX as f64) as u32
}

fn windows_scroll_message_and_delta(direction: DesktopScrollDirection, pages: f64) -> (u32, i32) {
    let delta = (120.0 * pages).round().clamp(1.0, i32::MAX as f64) as i32;
    match direction {
        DesktopScrollDirection::Up => (WM_MOUSEWHEEL, delta),
        DesktopScrollDirection::Down => (WM_MOUSEWHEEL, -delta),
        DesktopScrollDirection::Left => (WM_MOUSEHWHEEL, delta),
        DesktopScrollDirection::Right => (WM_MOUSEHWHEEL, -delta),
    }
}

fn windows_wheel_wparam(delta: i32) -> WPARAM {
    WPARAM(usize::from(delta as i16 as u16) << 16)
}

fn windows_point_lparam(x: i32, y: i32) -> LPARAM {
    let packed = u32::from(x as i16 as u16) | (u32::from(y as i16 as u16) << 16);
    LPARAM(packed as isize)
}

fn drag(params: &Value) -> Result<Value> {
    let Some(hwnd) = target_window(params) else {
        return Ok(stale_target());
    };
    let from_x = int_param(params, "fromX")?;
    let from_y = int_param(params, "fromY")?;
    let to_x = int_param(params, "toX")?;
    let to_y = int_param(params, "toY")?;
    post_targeted_drag(hwnd, (from_x, from_y), (to_x, to_y))?;
    pulse_visual_cursor(to_x, to_y, Some(hwnd));
    Ok(json!({ "status": "ok", "inputMode": "targeted_window_message" }))
}

fn post_targeted_drag(hwnd: HWND, from: (i32, i32), to: (i32, i32)) -> Result<()> {
    let start = screen_to_client_point(hwnd, from)?;
    let screen_points = desktop_drag_points(
        (i64::from(from.0), i64::from(from.1)),
        (i64::from(to.0), i64::from(to.1)),
        12,
    );
    let client_points = screen_points
        .iter()
        .map(|point| screen_to_client_point(hwnd, (point.0 as i32, point.1 as i32)))
        .collect::<Result<Vec<_>>>()?;
    move_visual_cursor(from.0, from.1, Some(hwnd));
    settle_visual_cursor(from.0, from.1, Some(hwnd));
    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_MOUSEMOVE,
            WPARAM(0),
            windows_point_lparam(start.x, start.y),
        )?;
        PostMessageW(
            Some(hwnd),
            WM_LBUTTONDOWN,
            WPARAM(1),
            windows_point_lparam(start.x, start.y),
        )?;
    }
    for (point, client_point) in screen_points.iter().zip(&client_points) {
        let screen_point = (point.0 as i32, point.1 as i32);
        unsafe {
            PostMessageW(
                Some(hwnd),
                WM_MOUSEMOVE,
                WPARAM(1),
                windows_point_lparam(client_point.x, client_point.y),
            )?;
        }
        move_visual_cursor(screen_point.0, screen_point.1, Some(hwnd));
        thread::sleep(Duration::from_millis(20));
    }
    let end = client_points.last().expect("drag path is non-empty");
    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_LBUTTONUP,
            WPARAM(0),
            windows_point_lparam(end.x, end.y),
        )?;
    }
    settle_visual_cursor(to.0, to.1, Some(hwnd));
    Ok(())
}

fn screen_to_client_point(hwnd: HWND, point: (i32, i32)) -> Result<POINT> {
    let mut point = POINT {
        x: point.0,
        y: point.1,
    };
    if !unsafe { ScreenToClient(hwnd, &mut point) }.as_bool() {
        return Err(anyhow!("unable to map drag point into the target window"));
    }
    Ok(point)
}

fn press_key(params: &Value) -> Result<Value> {
    let Some(hwnd) = target_window(params) else {
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
    if keys.is_empty() {
        return Ok(json!({ "status": "failed", "message": "key or keys is required" }));
    }
    let virtual_keys = keys
        .iter()
        .map(|key| virtual_key(key))
        .collect::<Result<Vec<_>>>()?;
    post_targeted_key_chord(hwnd, &virtual_keys)?;
    Ok(json!({ "status": "ok", "inputMode": "targeted_window_message" }))
}

fn type_text(params: &Value) -> Result<Value> {
    let Some(hwnd) = target_window(params) else {
        return Ok(stale_target());
    };
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let input_mode = if let Some(edit_hwnd) = find_targeted_text_window(params, hwnd)? {
        send_text_to_edit_window(edit_hwnd, text);
        "targeted_edit_message"
    } else {
        post_targeted_text(hwnd, text)?;
        "targeted_window_message"
    };
    Ok(json!({ "status": "ok", "inputMode": input_mode }))
}

fn post_targeted_key_chord(hwnd: HWND, keys: &[VIRTUAL_KEY]) -> Result<()> {
    for (message, key) in windows_key_message_sequence(keys) {
        unsafe {
            PostMessageW(Some(hwnd), message, WPARAM(key), LPARAM(0))?;
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn windows_key_message_sequence(keys: &[VIRTUAL_KEY]) -> Vec<(u32, usize)> {
    keys.iter()
        .map(|key| (WM_KEYDOWN, key.0 as usize))
        .chain(keys.iter().rev().map(|key| (WM_KEYUP, key.0 as usize)))
        .collect()
}

fn post_targeted_text(hwnd: HWND, text: &str) -> Result<()> {
    for (message, code_unit) in windows_text_message_sequence(text) {
        unsafe {
            PostMessageW(Some(hwnd), message, WPARAM(code_unit), LPARAM(0))?;
        }
        thread::sleep(Duration::from_millis(8));
    }
    Ok(())
}

fn windows_text_message_sequence(text: &str) -> Vec<(u32, usize)> {
    text.encode_utf16()
        .map(|code_unit| (WM_CHAR, usize::from(code_unit)))
        .collect()
}

fn send_text_to_edit_window(hwnd: HWND, text: &str) {
    const EM_SETSEL: u32 = 0x00B1;
    const EM_REPLACESEL: u32 = 0x00C2;
    let mut text = text.encode_utf16().collect::<Vec<_>>();
    text.push(0);
    unsafe {
        SendMessageW(hwnd, EM_SETSEL, Some(WPARAM(usize::MAX)), Some(LPARAM(-1)));
        SendMessageW(
            hwnd,
            EM_REPLACESEL,
            Some(WPARAM(1)),
            Some(LPARAM(text.as_ptr() as isize)),
        );
    }
}

fn find_targeted_text_window(params: &Value, root_hwnd: HWND) -> Result<Option<HWND>> {
    if let Some(element) = resolve_element(params)? {
        if let Some(hwnd) = text_window_handle_candidate(&element, root_hwnd, false) {
            return Ok(Some(hwnd));
        }
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let walker = automation.ControlViewWalker()?;
        let root = automation.ElementFromHandle(root_hwnd)?;
        Ok(
            find_descendant_text_window(&walker, &root, root_hwnd, true, 0)
                .or_else(|| find_descendant_text_window(&walker, &root, root_hwnd, false, 0)),
        )
    }
}

fn find_descendant_text_window(
    walker: &IUIAutomationTreeWalker,
    root: &IUIAutomationElement,
    root_hwnd: HWND,
    require_writable: bool,
    depth: usize,
) -> Option<HWND> {
    if depth >= 12 {
        return None;
    }
    let mut child = unsafe { walker.GetFirstChildElement(root) }.ok();
    while let Some(element) = child {
        if let Some(hwnd) = text_window_handle_candidate(&element, root_hwnd, require_writable) {
            return Some(hwnd);
        }
        if let Some(hwnd) =
            find_descendant_text_window(walker, &element, root_hwnd, require_writable, depth + 1)
        {
            return Some(hwnd);
        }
        child = unsafe { walker.GetNextSiblingElement(&element) }.ok();
    }
    None
}

fn text_window_handle_candidate(
    element: &IUIAutomationElement,
    root_hwnd: HWND,
    require_writable: bool,
) -> Option<HWND> {
    let hwnd = unsafe { element.CurrentNativeWindowHandle() }.ok()?;
    if hwnd == root_hwnd || !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return None;
    }
    let role = unsafe { element.CurrentControlType() }
        .map(control_type_name)
        .unwrap_or("unknown");
    let class_name = unsafe { element.CurrentClassName() }
        .map(|value| value.to_string().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(role, "edit" | "document")
        && !["edit", "rich", "text"]
            .iter()
            .any(|needle| class_name.contains(needle))
    {
        return None;
    }
    if require_writable {
        let pattern =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
                .ok()?;
        if unsafe { pattern.CurrentIsReadOnly() }.ok()?.as_bool() {
            return None;
        }
    }
    Some(hwnd)
}

fn set_value(params: &Value) -> Result<Value> {
    let Some(target) = target_window(params) else {
        return Ok(stale_target());
    };
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
        "targeted_window_message"
    }
}

fn preferred_pointer_move_injection() -> &'static str {
    "targeted_window_message"
}

fn windows_button_message_spec(button: DesktopMouseButton) -> (u32, u32, usize) {
    match button {
        DesktopMouseButton::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, 0x0001),
        DesktopMouseButton::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, 0x0002),
        DesktopMouseButton::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, 0x0010),
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

    #[test]
    fn prefers_uia_then_targeted_window_messages_for_clicks() {
        assert_eq!(
            preferred_pointer_injection(&json!({ "elementId": "0.1" }), DesktopMouseButton::Left,),
            "uia"
        );
        assert_eq!(
            preferred_pointer_injection(&json!({ "elementId": "0.1" }), DesktopMouseButton::Right,),
            "targeted_window_message"
        );
        assert_eq!(
            preferred_pointer_injection(&json!({ "elementId": "0.1" }), DesktopMouseButton::Middle,),
            "targeted_window_message"
        );
        assert_eq!(
            preferred_pointer_injection(&json!({ "x": 10, "y": 20 }), DesktopMouseButton::Left,),
            "targeted_window_message"
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
    fn moves_pointer_with_targeted_window_messages() {
        assert_eq!(
            preferred_pointer_move_injection(),
            "targeted_window_message"
        );
    }

    #[test]
    fn orders_targeted_key_messages_like_the_reference_runtime() {
        assert_eq!(
            windows_key_message_sequence(&[VK_CONTROL, VIRTUAL_KEY(b'S' as u16)]),
            vec![
                (WM_KEYDOWN, VK_CONTROL.0 as usize),
                (WM_KEYDOWN, b'S' as usize),
                (WM_KEYUP, b'S' as usize),
                (WM_KEYUP, VK_CONTROL.0 as usize),
            ]
        );
    }

    #[test]
    fn encodes_targeted_text_as_utf16_window_messages() {
        assert_eq!(
            windows_text_message_sequence("A😀"),
            vec![(WM_CHAR, 0x41), (WM_CHAR, 0xD83D), (WM_CHAR, 0xDE00)]
        );
    }

    #[test]
    fn rejects_empty_print_window_frames_before_screen_fallback() {
        assert!(!pixels_have_visible_content(&[0; 16]));
        assert!(pixels_have_visible_content(&[0, 0, 0, 0, 12, 0, 0, 0,]));
    }

    #[test]
    fn maps_mouse_buttons_to_targeted_window_messages() {
        assert_eq!(
            windows_button_message_spec(DesktopMouseButton::Left),
            (WM_LBUTTONDOWN, WM_LBUTTONUP, 0x0001)
        );
        assert_eq!(
            windows_button_message_spec(DesktopMouseButton::Right),
            (WM_RBUTTONDOWN, WM_RBUTTONUP, 0x0002)
        );
        assert_eq!(
            windows_button_message_spec(DesktopMouseButton::Middle),
            (WM_MBUTTONDOWN, WM_MBUTTONUP, 0x0010)
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
    fn maps_scroll_directions_to_uia_amounts() {
        assert_eq!(
            windows_scroll_amounts(DesktopScrollDirection::Up),
            (ScrollAmount_NoAmount, ScrollAmount_LargeDecrement)
        );
        assert_eq!(
            windows_scroll_amounts(DesktopScrollDirection::Down),
            (ScrollAmount_NoAmount, ScrollAmount_LargeIncrement)
        );
        assert_eq!(
            windows_scroll_amounts(DesktopScrollDirection::Left),
            (ScrollAmount_LargeDecrement, ScrollAmount_NoAmount)
        );
        assert_eq!(
            windows_scroll_amounts(DesktopScrollDirection::Right),
            (ScrollAmount_LargeIncrement, ScrollAmount_NoAmount)
        );
    }

    #[test]
    fn maps_fractional_scroll_pages_to_targeted_wheel_messages() {
        assert_eq!(windows_scroll_repeat_count(0.5), 1);
        assert_eq!(windows_scroll_repeat_count(1.2), 2);
        assert_eq!(
            windows_scroll_message_and_delta(DesktopScrollDirection::Up, 1.0),
            (WM_MOUSEWHEEL, 120)
        );
        assert_eq!(
            windows_scroll_message_and_delta(DesktopScrollDirection::Right, 0.5),
            (WM_MOUSEHWHEEL, -60)
        );
        assert_eq!(windows_wheel_wparam(-60).0, (u16::MAX as usize - 59) << 16);
        assert_eq!(
            windows_point_lparam(-10, 20).0 as u32,
            (20_u32 << 16) | u32::from((-10_i16) as u16)
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
    }
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
