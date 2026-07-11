use crate::{
    current_computer_use_permission_app_bundle_name,
    current_computer_use_permission_app_bundle_path, current_computer_use_permission_clients,
    desktop_click_options, desktop_drag_points, desktop_permission_diagnostics,
    desktop_permission_granted, desktop_permission_guide_launch_for_app_bundle_path,
    desktop_scroll_options, macos_overlay,
    macos_snapshot::{
        find_macos_window, first_visible_user_window, macos_click_action_points,
        macos_click_candidate_contains_point, macos_click_event_codes,
        macos_current_context_result_with_related, macos_get_window_result,
        macos_get_window_state_result_with_related, macos_global_pointer_fallback_enabled_from,
        macos_integral_scroll_page_count, macos_key_chord, macos_likely_containing_row_action,
        macos_likely_synthetic_side_action, macos_list_apps_result_with_discovered,
        macos_list_windows_result, macos_matching_secondary_action,
        macos_non_sensitive_selected_text, macos_png_data_url, macos_pointer_input_mode,
        macos_pointer_requires_activation, macos_preferred_click_actions,
        macos_related_transient_windows, macos_resolve_action_point,
        macos_screen_capture_helper_path, macos_scroll_action_name, macos_scroll_wheel_deltas,
        macos_set_value_attribute_is_settable, macos_should_prefer_containing_web_row,
        macos_text_target_is_sensitive, macos_visible_pointer_enabled_from,
        macos_visible_pointer_mode, macos_visible_pointer_motion_points,
        macos_wait_for_state_result, MacOSDiscoveredApp, MacOSElementInfo, MacOSWindowInfo,
        MACOS_LUME_GLOBAL_POINTER_FALLBACK_ENV, MACOS_LUME_VISUAL_POINTER_ENV,
        MACOS_NON_SETTABLE_SET_VALUE_ERROR, MACOS_OPEN_COMPUTER_USE_GLOBAL_POINTER_FALLBACK_ENV,
        MACOS_OPEN_COMPUTER_USE_VISUAL_POINTER_ENV,
    },
    DesktopBackend, DesktopClickOptions, DesktopMouseButton, DesktopPermissionClientRecord,
    DesktopScrollOptions,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    ffi::{CStr, CString},
    os::raw::{
        c_char, c_double, c_float, c_int, c_long, c_uchar, c_uint, c_ulong, c_ushort, c_void,
    },
    path::Path,
    process::Command,
    ptr,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

pub struct MacOSDesktopBackend;

impl DesktopBackend for MacOSDesktopBackend {
    fn invoke(&self, method: &str, params: &Value) -> Result<Value> {
        if method == "list_apps" {
            let windows = system_windows().unwrap_or_default();
            let discovered = discover_macos_apps();
            return Ok(macos_list_apps_result_with_discovered(
                &windows,
                &discovered,
            ));
        }
        if method == "launch_app" {
            return Ok(launch_app(params));
        }
        let permissions = permission_state();
        if method == "diagnose_permissions" {
            return Ok(desktop_permission_diagnostics(
                permissions.accessibility,
                permissions.screen_recording,
                None,
            ));
        }
        if method == "request_permissions" {
            return Ok(request_permissions(permissions));
        }
        if !permissions.all_granted() {
            return Ok(desktop_permission_diagnostics(
                permissions.accessibility,
                permissions.screen_recording,
                Some(format!(
                    "macOS desktop control requires Accessibility and Screen Recording permissions for {}",
                    current_computer_use_permission_app_bundle_name()
                )),
            ));
        }
        if method == "wait_for_state" {
            return wait_for_state(params);
        }
        let windows = system_windows()?;
        match method {
            "list_windows" => Ok(macos_list_windows_result(
                &windows,
                params.get("appId").and_then(Value::as_str),
            )),
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
                let mut related = macos_related_transient_windows(&windows, &window, 2);
                enrich_accessibility_text(&mut window);
                let include_screenshot =
                    params.get("includeScreenshot").and_then(Value::as_bool) == Some(true);
                capture_screenshot_if_requested(&mut window, include_screenshot);
                for related_window in &mut related {
                    capture_screenshot_if_requested(related_window, include_screenshot);
                }
                Ok(macos_current_context_result_with_related(
                    &window,
                    &related,
                    include_screenshot,
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
                let mut related = macos_related_transient_windows(&windows, &window, 2);
                let mut window = window;
                enrich_accessibility_text(&mut window);
                let include_screenshot =
                    params.get("includeScreenshot").and_then(Value::as_bool) == Some(true);
                capture_screenshot_if_requested(&mut window, include_screenshot);
                for related_window in &mut related {
                    capture_screenshot_if_requested(related_window, include_screenshot);
                }
                Ok(macos_get_window_state_result_with_related(
                    &window,
                    &related,
                    include_screenshot,
                ))
            }
            "activate_window" => activate_window(params, &windows),
            "move_pointer" => move_pointer(params, &windows),
            "click" => click(params, &windows),
            "perform_secondary_action" => perform_secondary_action(params, &windows),
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

fn discover_macos_apps() -> Vec<MacOSDiscoveredApp> {
    let Ok(current_exe) = env::current_exe() else {
        return Vec::new();
    };
    let Some(directory) = current_exe.parent() else {
        return Vec::new();
    };
    let helper = directory.join("LumeComputerUseAppDiscovery");
    let Ok(output) = Command::new(helper).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    serde_json::from_slice(&output.stdout).unwrap_or_default()
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
    if macos_pointer_requires_activation(false) {
        activate_macos_window(&window)?;
    }
    move_mouse(x, y, window.owner_pid as c_int, false);
    Ok(json!({
        "status": "ok",
        "inputMode": macos_pointer_input_mode(false),
        "visualPointer": visual_pointer_mode()
    }))
}

fn click(params: &Value, windows: &[MacOSWindowInfo]) -> Result<Value> {
    let options = match desktop_click_options(params, false) {
        Ok(options) => options,
        Err(message) => return Ok(failed_action(message)),
    };
    let Some(mut window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
    enrich_accessibility_text(&mut window);
    let (x, y) = match macos_resolve_action_point(&window, params) {
        Ok(point) => point,
        Err(result) => return Ok(result),
    };
    move_visible_pointer(x, y);
    if let Some(input_mode) = perform_ax_click_action(
        &window,
        params.get("elementId").and_then(Value::as_str),
        (x, y),
        options,
    )? {
        pulse_visible_pointer(x, y);
        return Ok(json!({
            "status": "ok",
            "inputMode": input_mode,
            "visualPointer": visual_pointer_mode()
        }));
    }
    let global_pointer_fallback = global_pointer_fallback_enabled();
    if macos_pointer_requires_activation(global_pointer_fallback) {
        activate_macos_window(&window)?;
    }
    move_mouse(x, y, window.owner_pid as c_int, global_pointer_fallback);
    click_mouse(
        x,
        y,
        options,
        window.owner_pid as c_int,
        global_pointer_fallback,
    );
    pulse_visible_pointer(x, y);
    Ok(json!({
        "status": "ok",
        "inputMode": macos_pointer_input_mode(global_pointer_fallback),
        "visualPointer": visual_pointer_mode()
    }))
}

fn perform_secondary_action(params: &Value, windows: &[MacOSWindowInfo]) -> Result<Value> {
    let Some(window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
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

    unsafe {
        let app = AXUIElementCreateApplication(window.owner_pid as c_int);
        if app.is_null() {
            return Ok(stale_target());
        }
        let root = matching_ax_window(app, window.window_id).or_else(|| first_ax_window(app));
        let Some(root) = root else {
            CFRelease(app as CFTypeRef);
            return Ok(stale_target());
        };
        let element = matching_ax_element_by_id(root, element_id);
        let Some(element) = element else {
            CFRelease(root as CFTypeRef);
            CFRelease(app as CFTypeRef);
            return Ok(json!({
                "status": "stale_target",
                "message": "target element is unavailable",
            }));
        };
        let actions = copy_ax_action_names(element);
        let matching_action = macos_matching_secondary_action(&actions, requested_action);
        let result = match matching_action {
            Some(action) if perform_ax_action(element, action) => {
                json!({ "status": "ok", "inputMode": "accessibility_action" })
            }
            Some(action) => failed_action(&format!("AXUIElementPerformAction({action}) failed")),
            None => failed_action(&format!(
                "{requested_action} is not a valid secondary action for {element_id}"
            )),
        };
        CFRelease(element as CFTypeRef);
        CFRelease(root as CFTypeRef);
        CFRelease(app as CFTypeRef);
        Ok(result)
    }
}

fn perform_ax_click_action(
    window: &MacOSWindowInfo,
    element_id: Option<&str>,
    point: (i64, i64),
    options: DesktopClickOptions,
) -> Result<Option<&'static str>> {
    if options.button == DesktopMouseButton::Middle {
        return Ok(None);
    }
    unsafe {
        let app = AXUIElementCreateApplication(window.owner_pid as c_int);
        if app.is_null() {
            return Ok(None);
        }
        let mut handled = false;
        if let Some(element_id) = element_id {
            let root = matching_ax_window(app, window.window_id).or_else(|| first_ax_window(app));
            if let Some(root) = root {
                if let Some(element) = matching_ax_element_by_id(root, element_id) {
                    handled = perform_containing_web_row_click(window, element, options);
                    if !handled {
                        handled = perform_preferred_ax_click_action(element, options);
                    }
                    if !handled {
                        let mut remaining = 64;
                        handled = perform_descendant_ax_click_action(
                            element,
                            options,
                            point,
                            0,
                            &mut remaining,
                        );
                    }
                    if !handled {
                        handled = perform_nearby_ax_click_action(app, element, options);
                    }
                    CFRelease(element as CFTypeRef);
                }
                CFRelease(root as CFTypeRef);
            }
        }
        if !handled {
            let mut hit_element = ptr::null();
            let hit_result = AXUIElementCopyElementAtPosition(
                app,
                point.0 as c_float,
                point.1 as c_float,
                &mut hit_element,
            );
            if !hit_element.is_null() {
                if hit_result == K_AX_ERROR_SUCCESS {
                    handled = perform_containing_web_row_click(window, hit_element, options);
                    if !handled {
                        handled = perform_preferred_ax_click_action(hit_element, options);
                    }
                    if !handled {
                        let mut remaining = 64;
                        handled = perform_descendant_ax_click_action(
                            hit_element,
                            options,
                            point,
                            0,
                            &mut remaining,
                        );
                    }
                }
                CFRelease(hit_element as CFTypeRef);
            }
        }
        CFRelease(app as CFTypeRef);
        Ok(
            handled.then_some(if options.button == DesktopMouseButton::Right {
                "accessibility_menu"
            } else {
                "accessibility_action"
            }),
        )
    }
}

unsafe fn perform_preferred_ax_click_action(
    element: AXUIElementRef,
    options: DesktopClickOptions,
) -> bool {
    if options.button == DesktopMouseButton::Left
        && options.count == 1
        && !has_ax_ancestor_role(element, "AXWebArea", 12)
        && select_containing_list_item(element)
    {
        thread::sleep(Duration::from_millis(150));
        return true;
    }
    let available_actions = copy_ax_action_names(element);
    macos_preferred_click_actions(options.button == DesktopMouseButton::Right)
        .iter()
        .filter(|preferred| {
            available_actions
                .iter()
                .any(|available| available.eq_ignore_ascii_case(preferred))
        })
        .any(|action| (0..options.count).all(|_| perform_ax_action(element, action)))
}

unsafe fn select_containing_list_item(element: AXUIElementRef) -> bool {
    let retained = CFRetain(element as CFTypeRef);
    if retained.is_null() {
        return false;
    }
    let mut current = retained as AXUIElementRef;
    for _ in 0..8 {
        let Some(parent) = copy_ax_attribute(current, "AXParent") else {
            CFRelease(current as CFTypeRef);
            return false;
        };
        let is_selectable_list = copy_ax_string_attribute(parent as AXUIElementRef, "AXRole")
            .is_some_and(|role| role == "AXList")
            && ax_attribute_is_settable(parent as AXUIElementRef, "AXSelectedChildren")
                .unwrap_or(false);
        if is_selectable_list {
            let selected = set_ax_element_array_attribute(
                parent as AXUIElementRef,
                "AXSelectedChildren",
                current,
            );
            CFRelease(parent);
            CFRelease(current as CFTypeRef);
            return selected;
        }
        CFRelease(current as CFTypeRef);
        current = parent as AXUIElementRef;
    }
    CFRelease(current as CFTypeRef);
    false
}

unsafe fn perform_containing_web_row_click(
    window: &MacOSWindowInfo,
    element: AXUIElementRef,
    options: DesktopClickOptions,
) -> bool {
    if options.button != DesktopMouseButton::Left || options.count != 1 {
        return false;
    }
    let role = copy_ax_string_attribute(element, "AXRole");
    if !macos_should_prefer_containing_web_row(
        role.as_deref(),
        false,
        has_ax_ancestor_role(element, "AXWebArea", 12),
        &window.owner_name,
        window.bundle_identifier.as_deref(),
    ) {
        return false;
    }
    let Some(target_frame) = ax_element_frame(element) else {
        return false;
    };
    let retained = CFRetain(element as CFTypeRef);
    if retained.is_null() {
        return false;
    }
    let mut current = retained as AXUIElementRef;
    for _ in 0..6 {
        let Some(parent) = copy_ax_attribute(current, "AXParent") else {
            break;
        };
        CFRelease(current as CFTypeRef);
        current = parent as AXUIElementRef;
        let actions = copy_ax_action_names(current);
        let has_primary_action = actions
            .iter()
            .any(|action| action.eq_ignore_ascii_case("AXPress"));
        let Some(candidate_frame) = ax_element_frame(current) else {
            continue;
        };
        if macos_likely_containing_row_action(target_frame, candidate_frame, has_primary_action)
            && !ax_element_is_likely_side_action(element, current)
            && perform_ax_action(current, "AXPress")
        {
            CFRelease(current as CFTypeRef);
            thread::sleep(Duration::from_millis(150));
            return true;
        }
    }
    CFRelease(current as CFTypeRef);
    false
}

unsafe fn perform_nearby_ax_click_action(
    app: AXUIElementRef,
    element: AXUIElementRef,
    options: DesktopClickOptions,
) -> bool {
    let Some((origin, size)) = copy_ax_point_attribute(element, "AXPosition")
        .zip(copy_ax_size_attribute(element, "AXSize"))
    else {
        return false;
    };
    let role = copy_ax_string_attribute(element, "AXRole");
    for point in macos_click_action_points(origin, size, role.as_deref() == Some("AXStaticText")) {
        let mut hit_element = ptr::null();
        if AXUIElementCopyElementAtPosition(
            app,
            point.0 as c_float,
            point.1 as c_float,
            &mut hit_element,
        ) != K_AX_ERROR_SUCCESS
            || hit_element.is_null()
        {
            continue;
        }
        let blocked_side_action = ax_element_is_likely_side_action(element, hit_element);
        let handled =
            !blocked_side_action && perform_preferred_ax_click_action(hit_element, options);
        CFRelease(hit_element as CFTypeRef);
        if handled {
            return true;
        }
    }
    false
}

unsafe fn has_ax_ancestor_role(
    element: AXUIElementRef,
    expected_role: &str,
    max_depth: usize,
) -> bool {
    let retained = CFRetain(element as CFTypeRef);
    if retained.is_null() {
        return false;
    }
    let mut current = retained as AXUIElementRef;
    for _ in 0..max_depth {
        let Some(parent) = copy_ax_attribute(current, "AXParent") else {
            break;
        };
        CFRelease(current as CFTypeRef);
        current = parent as AXUIElementRef;
        if copy_ax_string_attribute(current, "AXRole").as_deref() == Some(expected_role) {
            CFRelease(current as CFTypeRef);
            return true;
        }
    }
    CFRelease(current as CFTypeRef);
    false
}

unsafe fn ax_element_frame(element: AXUIElementRef) -> Option<(f64, f64, f64, f64)> {
    copy_ax_point_attribute(element, "AXPosition")
        .zip(copy_ax_size_attribute(element, "AXSize"))
        .map(|((x, y), (width, height))| (x, y, width, height))
}

unsafe fn ax_element_is_likely_side_action(
    parent: AXUIElementRef,
    candidate: AXUIElementRef,
) -> bool {
    let Some(parent_frame) = ax_element_frame(parent) else {
        return false;
    };
    let Some(candidate_frame) = ax_element_frame(candidate) else {
        return false;
    };
    let actions = copy_ax_action_names(candidate);
    let has_primary_action = actions.iter().any(|action| {
        matches!(
            action.to_ascii_lowercase().as_str(),
            "axpress" | "axconfirm" | "axopen" | "axshowmenu"
        )
    });
    let labels = [
        "AXTitle",
        "AXDescription",
        "AXHelp",
        "AXValue",
        "AXIdentifier",
    ]
    .iter()
    .filter_map(|attribute| copy_ax_string_attribute(candidate, attribute))
    .collect::<Vec<_>>();
    macos_likely_synthetic_side_action(parent_frame, candidate_frame, has_primary_action, &labels)
}

unsafe fn perform_descendant_ax_click_action(
    parent: AXUIElementRef,
    options: DesktopClickOptions,
    point: (i64, i64),
    depth: usize,
    remaining: &mut usize,
) -> bool {
    if depth >= 3 || *remaining == 0 {
        return false;
    }
    let Some(children) = copy_ax_attribute(parent, "AXChildren") else {
        return false;
    };
    if !cf_type_matches(children as CFTypeRef, CFArrayGetTypeID()) {
        CFRelease(children as CFTypeRef);
        return false;
    }
    let count = CFArrayGetCount(children as CFArrayRef);
    let mut handled = false;
    for index in 0..count {
        if *remaining == 0 {
            break;
        }
        *remaining -= 1;
        let child = CFArrayGetValueAtIndex(children as CFArrayRef, index) as AXUIElementRef;
        if child.is_null() {
            continue;
        }
        let origin = copy_ax_point_attribute(child, "AXPosition");
        let size = copy_ax_size_attribute(child, "AXSize");
        let contains_point = origin.zip(size).is_some_and(|(origin, size)| {
            macos_click_candidate_contains_point(origin, size, point)
        });
        if origin.is_some() && size.is_some() && !contains_point {
            continue;
        }
        if perform_descendant_ax_click_action(child, options, point, depth + 1, remaining) {
            handled = true;
            break;
        }
        if contains_point && perform_preferred_ax_click_action(child, options) {
            handled = true;
            break;
        }
    }
    CFRelease(children as CFTypeRef);
    handled
}

fn scroll(params: &Value, windows: &[MacOSWindowInfo]) -> Result<Value> {
    let options = match desktop_scroll_options(params) {
        Ok(options) => options,
        Err(message) => return Ok(failed_action(message)),
    };
    let Some(window) = required_window(params, windows) else {
        return Ok(stale_target());
    };
    let (x, y) = match macos_resolve_action_point(&window, params) {
        Ok(point) => point,
        Err(result) => return Ok(result),
    };
    if let Some(element_id) = params.get("elementId").and_then(Value::as_str) {
        if let Some(handled) = perform_element_scroll_action(&window, element_id, options)? {
            return Ok(if handled {
                json!({ "status": "ok", "inputMode": "accessibility_scroll" })
            } else {
                failed_action("AX scroll action failed")
            });
        }
    }
    let global_pointer_fallback = global_pointer_fallback_enabled();
    if global_pointer_fallback {
        activate_macos_window(&window)?;
    }
    let (vertical, horizontal) = macos_scroll_wheel_deltas(options.direction, options.pages);
    scroll_mouse(
        x,
        y,
        vertical,
        horizontal,
        window.owner_pid as c_int,
        global_pointer_fallback,
    );
    Ok(json!({
        "status": "ok",
        "inputMode": if global_pointer_fallback { "global_scroll_event" } else { "targeted_scroll_event" },
        "visualPointer": visual_pointer_mode(),
    }))
}

fn perform_element_scroll_action(
    window: &MacOSWindowInfo,
    element_id: &str,
    options: DesktopScrollOptions,
) -> Result<Option<bool>> {
    let Some(repeat_count) = macos_integral_scroll_page_count(options.pages) else {
        return Ok(None);
    };
    let requested_action = macos_scroll_action_name(options.direction);
    unsafe {
        let app = AXUIElementCreateApplication(window.owner_pid as c_int);
        if app.is_null() {
            return Ok(Some(false));
        }
        let root = matching_ax_window(app, window.window_id).or_else(|| first_ax_window(app));
        let Some(root) = root else {
            CFRelease(app as CFTypeRef);
            return Ok(Some(false));
        };
        let element = matching_ax_element_by_id(root, element_id);
        let Some(element) = element else {
            CFRelease(root as CFTypeRef);
            CFRelease(app as CFTypeRef);
            return Ok(Some(false));
        };
        let actions = copy_ax_action_names(element);
        let Some(action) = macos_matching_secondary_action(&actions, requested_action) else {
            CFRelease(element as CFTypeRef);
            CFRelease(root as CFTypeRef);
            CFRelease(app as CFTypeRef);
            return Ok(None);
        };
        let mut handled = true;
        for index in 0..repeat_count {
            handled &= perform_ax_action(element, action);
            if index + 1 < repeat_count {
                thread::sleep(Duration::from_millis(50));
            }
        }
        CFRelease(element as CFTypeRef);
        CFRelease(root as CFTypeRef);
        CFRelease(app as CFTypeRef);
        Ok(Some(handled))
    }
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
    let global_pointer_fallback = global_pointer_fallback_enabled();
    if global_pointer_fallback {
        activate_macos_window(&window)?;
    }
    drag_mouse(
        from_x,
        from_y,
        to_x,
        to_y,
        window.owner_pid as c_int,
        global_pointer_fallback,
    );
    Ok(json!({
        "status": "ok",
        "inputMode": if global_pointer_fallback { "global_drag_event" } else { "targeted_drag_event" },
        "visualPointer": visual_pointer_mode(),
    }))
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
    send_key(key_code as c_ushort, flags, window.owner_pid as c_int);
    Ok(json!({ "status": "ok", "inputMode": "targeted_event" }))
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
    move_visible_pointer_for_params(window, params);
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    send_text(text, window.owner_pid as c_int);
    Ok(json!({
        "status": "ok",
        "inputMode": "targeted_event",
        "visualPointer": visual_pointer_mode()
    }))
}

fn set_value(params: &Value, window: &MacOSWindowInfo) -> Result<Value> {
    let Some(element_id) = params.get("elementId").and_then(Value::as_str) else {
        return Ok(failed_action("elementId is required"));
    };
    let value = params
        .get("value")
        .and_then(Value::as_str)
        .unwrap_or_default();
    move_visible_pointer_for_params(window, params);
    if let Some(result) = set_accessibility_value(window, element_id, value)? {
        return Ok(with_visual_pointer(result));
    }
    Ok(stale_target())
}

fn set_accessibility_value(
    window: &MacOSWindowInfo,
    element_id: &str,
    value: &str,
) -> Result<Option<Value>> {
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
        let Some(element) = element else {
            CFRelease(root as CFTypeRef);
            CFRelease(app as CFTypeRef);
            return Ok(None);
        };
        let result = match ax_attribute_is_settable(element, "AXValue") {
            Ok(true) => match set_ax_string_attribute(element, "AXValue", value) {
                Ok(()) => json!({ "status": "ok", "inputMode": "accessibility_value" }),
                Err(message) => failed_action(&message),
            },
            Ok(false) => failed_action(MACOS_NON_SETTABLE_SET_VALUE_ERROR),
            Err(message) => failed_action(&message),
        };
        CFRelease(element as CFTypeRef);
        CFRelease(root as CFTypeRef);
        CFRelease(app as CFTypeRef);
        Ok(Some(result))
    }
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
        let include_screenshot =
            params.get("includeScreenshot").and_then(Value::as_bool) == Some(true);
        capture_screenshot_if_requested(&mut window, include_screenshot);
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

fn visual_pointer_enabled() -> bool {
    let lume_value = env::var(MACOS_LUME_VISUAL_POINTER_ENV).ok();
    let open_computer_use_value = env::var(MACOS_OPEN_COMPUTER_USE_VISUAL_POINTER_ENV).ok();
    macos_visible_pointer_enabled_from(lume_value.as_deref(), open_computer_use_value.as_deref())
}

fn visual_pointer_mode() -> &'static str {
    macos_visible_pointer_mode(visual_pointer_enabled())
}

fn with_visual_pointer(mut result: Value) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.insert("visualPointer".to_owned(), json!(visual_pointer_mode()));
    }
    result
}

fn move_visible_pointer_for_params(window: &MacOSWindowInfo, params: &Value) {
    if let Ok((x, y)) = macos_resolve_action_point(window, params) {
        move_visible_pointer(x, y);
    }
}

fn move_visible_pointer(x: i64, y: i64) {
    if !visual_pointer_enabled() {
        return;
    }
    let mut position = visual_pointer_position()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let start = position
        .as_ref()
        .copied()
        .or_else(current_mouse_location)
        .unwrap_or((x, y));
    let bounds = main_display_bounds();
    let points = macos_visible_pointer_motion_points(start, (x, y), bounds);
    for (index, (frame_x, frame_y)) in points.iter().copied().enumerate() {
        if !macos_overlay::move_cursor(frame_x, frame_y) {
            for (fallback_x, fallback_y) in points[index..].iter().copied() {
                warp_mouse(fallback_x, fallback_y);
                thread::sleep(Duration::from_millis(16));
            }
            *position = Some((x, y));
            return;
        }
        thread::sleep(Duration::from_millis(16));
    }
    *position = Some((x, y));
}

fn pulse_visible_pointer(x: i64, y: i64) {
    if visual_pointer_enabled() {
        let _ = macos_overlay::pulse_cursor(x, y);
    }
}

fn visual_pointer_position() -> &'static Mutex<Option<(i64, i64)>> {
    static POSITION: OnceLock<Mutex<Option<(i64, i64)>>> = OnceLock::new();
    POSITION.get_or_init(|| Mutex::new(None))
}

fn move_physical_pointer(x: i64, y: i64) {
    macos_overlay::hide_cursor();
    let start = current_mouse_location().unwrap_or((x, y));
    let bounds = main_display_bounds();
    for (frame_x, frame_y) in macos_visible_pointer_motion_points(start, (x, y), bounds) {
        warp_mouse(frame_x, frame_y);
        thread::sleep(Duration::from_millis(16));
    }
    *visual_pointer_position()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some((x, y));
}

fn current_mouse_location() -> Option<(i64, i64)> {
    unsafe {
        let event = CGEventCreate(ptr::null());
        if event.is_null() {
            return None;
        }
        let point = CGEventGetLocation(event);
        CFRelease(event as CFTypeRef);
        Some((point.x.round() as i64, point.y.round() as i64))
    }
}

fn main_display_bounds() -> (i64, i64, i64, i64) {
    unsafe {
        let bounds = CGDisplayBounds(CGMainDisplayID());
        (
            bounds.origin.x.round() as i64,
            bounds.origin.y.round() as i64,
            bounds.size.width.round() as i64,
            bounds.size.height.round() as i64,
        )
    }
}

fn warp_mouse(x: i64, y: i64) {
    unsafe {
        let _ = CGWarpMouseCursorPosition(cg_point(x, y));
    }
}

fn move_mouse(x: i64, y: i64, target_pid: c_int, global_pointer_fallback: bool) {
    if global_pointer_fallback {
        move_physical_pointer(x, y);
    } else {
        move_visible_pointer(x, y);
    }
    unsafe {
        let point = cg_point(x, y);
        if global_pointer_fallback {
            post_mouse_event(K_CG_EVENT_MOUSE_MOVED, point, K_CG_MOUSE_BUTTON_LEFT, None);
        } else {
            post_mouse_event(
                K_CG_EVENT_MOUSE_MOVED,
                point,
                K_CG_MOUSE_BUTTON_LEFT,
                Some(target_pid),
            );
        }
    }
}

fn click_mouse(
    x: i64,
    y: i64,
    options: DesktopClickOptions,
    target_pid: c_int,
    global_pointer_fallback: bool,
) {
    unsafe {
        let point = cg_point(x, y);
        let (down, up, button) = macos_click_event_codes(options.button);
        let event_target = (!global_pointer_fallback).then_some(target_pid);
        for click_state in 1..=options.count {
            post_mouse_click_event(down, point, button, event_target, i64::from(click_state));
            post_mouse_click_event(up, point, button, event_target, i64::from(click_state));
        }
        if !global_pointer_fallback {
            pulse_visible_pointer(x, y);
        }
    }
}

fn drag_mouse(
    from_x: i64,
    from_y: i64,
    to_x: i64,
    to_y: i64,
    target_pid: c_int,
    global_pointer_fallback: bool,
) {
    unsafe {
        let from = cg_point(from_x, from_y);
        if global_pointer_fallback {
            move_physical_pointer(from_x, from_y);
        } else {
            move_visible_pointer(from_x, from_y);
        }
        let event_target = (!global_pointer_fallback).then_some(target_pid);
        post_mouse_event(
            K_CG_EVENT_MOUSE_MOVED,
            from,
            K_CG_MOUSE_BUTTON_LEFT,
            event_target,
        );
        post_mouse_event(
            K_CG_EVENT_LEFT_MOUSE_DOWN,
            from,
            K_CG_MOUSE_BUTTON_LEFT,
            event_target,
        );
        for (x, y) in desktop_drag_points((from_x, from_y), (to_x, to_y), 10) {
            post_mouse_event(
                K_CG_EVENT_LEFT_MOUSE_DRAGGED,
                cg_point(x, y),
                K_CG_MOUSE_BUTTON_LEFT,
                event_target,
            );
        }
        if !global_pointer_fallback {
            move_visible_pointer(to_x, to_y);
        }
        post_mouse_event(
            K_CG_EVENT_LEFT_MOUSE_UP,
            cg_point(to_x, to_y),
            K_CG_MOUSE_BUTTON_LEFT,
            event_target,
        );
    }
}

fn scroll_mouse(
    x: i64,
    y: i64,
    vertical: c_int,
    horizontal: c_int,
    target_pid: c_int,
    global_pointer_fallback: bool,
) {
    unsafe {
        let event = CGEventCreateScrollWheelEvent(
            ptr::null(),
            K_CG_SCROLL_EVENT_UNIT_LINE,
            2,
            vertical,
            horizontal,
            0,
        );
        if !event.is_null() {
            CGEventSetLocation(event, cg_point(x, y));
        }
        post_event(event, (!global_pointer_fallback).then_some(target_pid));
    }
}

fn send_text(text: &str, target_pid: c_int) {
    for unit in text.encode_utf16() {
        unsafe {
            let down = CGEventCreateKeyboardEvent(ptr::null(), 0, true);
            if !down.is_null() {
                CGEventKeyboardSetUnicodeString(down, 1, &unit);
            }
            post_event(down, Some(target_pid));
            let up = CGEventCreateKeyboardEvent(ptr::null(), 0, false);
            if !up.is_null() {
                CGEventKeyboardSetUnicodeString(up, 1, &unit);
            }
            post_event(up, Some(target_pid));
        }
    }
}

fn send_key(key_code: c_ushort, flags: u64, target_pid: c_int) {
    unsafe {
        let down = CGEventCreateKeyboardEvent(ptr::null(), key_code, true);
        if !down.is_null() {
            CGEventSetFlags(down, flags);
        }
        post_event(down, Some(target_pid));
        let up = CGEventCreateKeyboardEvent(ptr::null(), key_code, false);
        if !up.is_null() {
            CGEventSetFlags(up, flags);
        }
        post_event(up, Some(target_pid));
    }
}

unsafe fn post_mouse_event(
    event_type: c_uint,
    point: CGPoint,
    button: c_uint,
    target_pid: Option<c_int>,
) {
    let event = CGEventCreateMouseEvent(ptr::null(), event_type, point, button);
    post_event(event, target_pid);
}

unsafe fn post_mouse_click_event(
    event_type: c_uint,
    point: CGPoint,
    button: c_uint,
    target_pid: Option<c_int>,
    click_state: i64,
) {
    let event = CGEventCreateMouseEvent(ptr::null(), event_type, point, button);
    if !event.is_null() {
        CGEventSetIntegerValueField(event, K_CG_MOUSE_EVENT_CLICK_STATE, click_state);
    }
    post_event(event, target_pid);
}

unsafe fn post_event(event: CGEventRef, target_pid: Option<c_int>) {
    if event.is_null() {
        return;
    }
    if let Some(target_pid) = target_pid {
        CGEventPostToPid(target_pid, event);
    } else {
        CGEventPost(K_CG_HID_EVENT_TAP, event);
    }
    CFRelease(event as CFTypeRef);
}

fn global_pointer_fallback_enabled() -> bool {
    let lume_value = env::var(MACOS_LUME_GLOBAL_POINTER_FALLBACK_ENV).ok();
    let open_computer_use_value =
        env::var(MACOS_OPEN_COMPUTER_USE_GLOBAL_POINTER_FALLBACK_ENV).ok();
    macos_global_pointer_fallback_enabled_from(
        lume_value.as_deref(),
        open_computer_use_value.as_deref(),
    )
}

fn capture_screenshot_if_requested(window: &mut MacOSWindowInfo, include_screenshot: bool) {
    if !include_screenshot {
        return;
    }
    match capture_window_png_data_url(window) {
        Ok(data_url) => window.screenshot_data_url = Some(data_url),
        Err(error) => window.screenshot_error = Some(error.to_string()),
    }
}

fn capture_window_png_data_url(window: &MacOSWindowInfo) -> Result<String> {
    if window.window_id > c_uint::MAX as u64 {
        return Err(anyhow!(
            "window id is too large for ScreenCaptureKit capture"
        ));
    }
    if window.width <= 0.0 || window.height <= 0.0 {
        return Err(anyhow!("window capture dimensions are empty"));
    }
    let host_executable = env::current_exe()?;
    let helper = macos_screen_capture_helper_path(&host_executable)
        .ok_or_else(|| anyhow!("desktop host executable has no parent directory"))?;
    if !helper.is_file() {
        return Err(anyhow!(
            "ScreenCaptureKit helper is unavailable: {}",
            helper.display()
        ));
    }
    let output = Command::new(&helper)
        .arg(window.window_id.to_string())
        .output()?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(anyhow!(if message.is_empty() {
            format!(
                "ScreenCaptureKit helper exited with status {}",
                output.status
            )
        } else {
            message
        }));
    }
    macos_png_data_url(&output.stdout).map_err(|message| anyhow!(message))
}

fn cg_point(x: i64, y: i64) -> CGPoint {
    CGPoint {
        x: x as c_double,
        y: y as c_double,
    }
}

struct MacOSPermissionState {
    accessibility: Option<bool>,
    screen_recording: Option<bool>,
}

impl MacOSPermissionState {
    fn all_granted(&self) -> bool {
        self.accessibility == Some(true) && self.screen_recording == Some(true)
    }

    fn app_bundle_available(&self) -> bool {
        self.accessibility.is_some() && self.screen_recording.is_some()
    }
}

fn permission_state() -> MacOSPermissionState {
    let clients = current_computer_use_permission_clients();
    if clients.is_empty() {
        return MacOSPermissionState {
            accessibility: None,
            screen_recording: None,
        };
    }
    let persisted = tcc_authorization_store(&clients);
    MacOSPermissionState {
        accessibility: Some(desktop_permission_granted(
            persisted.accessibility,
            ax_is_process_trusted(),
        )),
        screen_recording: Some(desktop_permission_granted(
            persisted.screen_recording,
            cg_preflight_screen_capture_access(),
        )),
    }
}

struct TccAuthorizationStore {
    accessibility: Option<bool>,
    screen_recording: Option<bool>,
}

fn tcc_authorization_store(clients: &[DesktopPermissionClientRecord]) -> TccAuthorizationStore {
    TccAuthorizationStore {
        accessibility: tcc_authorization_for_service("kTCCServiceAccessibility", clients),
        screen_recording: tcc_authorization_for_service("kTCCServiceScreenCapture", clients),
    }
}

fn tcc_authorization_for_service(
    service: &str,
    clients: &[DesktopPermissionClientRecord],
) -> Option<bool> {
    if clients.is_empty() {
        return None;
    }
    let mut saw_record = false;
    let mut granted = false;
    for database_path in tcc_database_paths() {
        if let Some(database_granted) =
            tcc_authorization_for_service_in_database(&database_path, service, clients)
        {
            saw_record = true;
            granted = granted || database_granted;
        }
    }
    saw_record.then_some(granted)
}

fn tcc_database_paths() -> Vec<String> {
    let mut paths = vec!["/Library/Application Support/com.apple.TCC/TCC.db".to_owned()];
    if let Ok(home) = env::var("HOME") {
        let home_database = format!("{home}/Library/Application Support/com.apple.TCC/TCC.db");
        if !paths.iter().any(|path| path == &home_database) {
            paths.push(home_database);
        }
    }
    paths
}

fn tcc_authorization_for_service_in_database(
    database_path: &str,
    service: &str,
    clients: &[DesktopPermissionClientRecord],
) -> Option<bool> {
    unsafe {
        let database_path = CString::new(database_path).ok()?;
        let mut database: *mut Sqlite3 = ptr::null_mut();
        if sqlite3_open_v2(
            database_path.as_ptr(),
            &mut database,
            SQLITE_OPEN_READONLY,
            ptr::null(),
        ) != SQLITE_OK
        {
            if !database.is_null() {
                sqlite3_close(database);
            }
            return None;
        }
        let result = tcc_authorization_for_service_in_open_database(database, service, clients);
        sqlite3_close(database);
        result
    }
}

unsafe fn tcc_authorization_for_service_in_open_database(
    database: *mut Sqlite3,
    service: &str,
    clients: &[DesktopPermissionClientRecord],
) -> Option<bool> {
    let query = CString::new(
        "SELECT auth_value FROM access WHERE service = ? AND client = ? AND client_type = ? ORDER BY last_modified DESC LIMIT 1;",
    )
    .ok()?;
    let service = CString::new(service).ok()?;
    let mut auth_values = Vec::new();

    for client in clients {
        let client_identifier = CString::new(client.identifier.as_str()).ok()?;
        let mut statement: *mut Sqlite3Stmt = ptr::null_mut();
        if sqlite3_prepare_v2(
            database,
            query.as_ptr(),
            -1,
            &mut statement,
            ptr::null_mut(),
        ) != SQLITE_OK
        {
            if !statement.is_null() {
                sqlite3_finalize(statement);
            }
            return None;
        }

        sqlite3_bind_text(statement, 1, service.as_ptr(), -1, None);
        sqlite3_bind_text(statement, 2, client_identifier.as_ptr(), -1, None);
        sqlite3_bind_int(statement, 3, client.client_type);

        if sqlite3_step(statement) == SQLITE_ROW {
            auth_values.push(sqlite3_column_int(statement, 0));
        }
        sqlite3_finalize(statement);
    }

    if auth_values.is_empty() {
        return None;
    }
    Some(tcc_authorization_granted(&auth_values))
}

fn tcc_authorization_granted(auth_values: &[i32]) -> bool {
    auth_values.contains(&2)
}

fn request_permissions(permissions: MacOSPermissionState) -> Value {
    if !permissions.app_bundle_available() {
        return desktop_permission_diagnostics(
            None,
            None,
            Some(
                "macOS permissions can only be requested by Lume Computer Use.app; relaunch the dedicated computer-use service"
                    .to_owned(),
            ),
        );
    }
    if permissions.accessibility == Some(false) {
        const SETTINGS_URL: &str =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
        request_accessibility_prompt();
        open_permission_guide("accessibility", SETTINGS_URL);
        open_permission_settings(SETTINGS_URL);
    } else if permissions.screen_recording == Some(false) {
        const SETTINGS_URL: &str =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
        request_screen_capture_access();
        open_permission_guide("screenRecording", SETTINGS_URL);
        open_permission_settings(SETTINGS_URL);
    }
    let updated = permission_state();
    desktop_permission_diagnostics(
        updated.accessibility,
        updated.screen_recording,
        Some(format!(
            "macOS permission request was started for {}",
            current_computer_use_permission_app_bundle_name()
        )),
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

fn open_permission_guide(permission_id: &str, settings_url: &str) {
    let Some(app_bundle_path) = current_computer_use_permission_app_bundle_path() else {
        return;
    };
    let Some(guide) = desktop_permission_guide_launch_for_app_bundle_path(
        Some(app_bundle_path.as_str()),
        permission_id,
        settings_url,
    ) else {
        return;
    };
    if !Path::new(&guide.executable_path).is_file() {
        return;
    }
    let _ = Command::new(&guide.executable_path)
        .args(&guide.args)
        .spawn();
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
            window.accessibility_truncated = text.truncated;
            window.elements = text.elements;
            CFRelease(root as CFTypeRef);
        }
        CFRelease(app as CFTypeRef);
    }
}

struct AxTextSnapshot {
    document_text: String,
    selected_text: Option<String>,
    truncated: bool,
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
        truncated: remaining == 0,
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
        if let Some(text) = macos_non_sensitive_selected_text(
            sensitive,
            copy_ax_string_attribute(element, "AXSelectedText"),
        ) {
            push_text(lines, &text);
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
    let actions = copy_ax_action_names(element);
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
        settable: ax_attribute_is_settable(element, "AXValue").unwrap_or(false),
        actions,
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

unsafe fn ax_attribute_is_settable(
    element: AXUIElementRef,
    attribute: &str,
) -> std::result::Result<bool, String> {
    let Some(attribute_ref) = create_cf_string(attribute) else {
        return Err(format!("invalid accessibility attribute: {attribute}"));
    };
    let mut settable = 0 as c_uchar;
    let result = AXUIElementIsAttributeSettable(element, attribute_ref, &mut settable);
    CFRelease(attribute_ref as CFTypeRef);
    macos_set_value_attribute_is_settable(result, settable != 0, attribute)
}

unsafe fn set_ax_string_attribute(
    element: AXUIElementRef,
    attribute: &str,
    value: &str,
) -> std::result::Result<(), String> {
    let Some(attribute_ref) = create_cf_string(attribute) else {
        return Err(format!("invalid accessibility attribute: {attribute}"));
    };
    let Some(value_ref) = create_cf_string(value) else {
        CFRelease(attribute_ref as CFTypeRef);
        return Err("invalid accessibility string value".to_owned());
    };
    let result = AXUIElementSetAttributeValue(element, attribute_ref, value_ref as CFTypeRef);
    CFRelease(value_ref as CFTypeRef);
    CFRelease(attribute_ref as CFTypeRef);
    if result == K_AX_ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("AXUIElementSetAttributeValue failed with {result}"))
    }
}

unsafe fn set_ax_element_array_attribute(
    element: AXUIElementRef,
    attribute: &str,
    child: AXUIElementRef,
) -> bool {
    let Some(attribute_ref) = create_cf_string(attribute) else {
        return false;
    };
    let values = [child as CFTypeRef];
    let array = CFArrayCreate(
        ptr::null(),
        values.as_ptr(),
        values.len() as CFIndex,
        ptr::null(),
    );
    if array.is_null() {
        CFRelease(attribute_ref as CFTypeRef);
        return false;
    }
    let result = AXUIElementSetAttributeValue(element, attribute_ref, array as CFTypeRef)
        == K_AX_ERROR_SUCCESS;
    CFRelease(array as CFTypeRef);
    CFRelease(attribute_ref as CFTypeRef);
    result
}

unsafe fn create_cf_string(value: &str) -> Option<CFStringRef> {
    let Ok(value) = CString::new(value) else {
        return None;
    };
    let value_ref =
        CFStringCreateWithCString(ptr::null(), value.as_ptr(), K_CF_STRING_ENCODING_UTF8);
    (!value_ref.is_null()).then_some(value_ref)
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

unsafe fn copy_ax_action_names(element: AXUIElementRef) -> Vec<String> {
    let mut actions: CFArrayRef = ptr::null();
    if AXUIElementCopyActionNames(element, &mut actions) != K_AX_ERROR_SUCCESS || actions.is_null()
    {
        return Vec::new();
    }
    let mut output = Vec::new();
    let count = CFArrayGetCount(actions);
    for index in 0..count {
        let action = CFArrayGetValueAtIndex(actions, index);
        if !action.is_null() && cf_type_matches(action, CFStringGetTypeID()) {
            if let Some(action) = cf_string_to_string(action as CFStringRef) {
                output.push(action);
            }
        }
    }
    CFRelease(actions as CFTypeRef);
    output
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
    let mut bundle_identifiers = HashMap::<u32, Option<String>>::new();
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
            let owner_pid = cf_dictionary_i64(dict, "kCGWindowOwnerPID").unwrap_or_default() as u32;
            let bundle_identifier = bundle_identifiers
                .entry(owner_pid)
                .or_insert_with(|| running_app_bundle_identifier(owner_pid))
                .clone();
            let mut window = MacOSWindowInfo {
                window_id: cf_dictionary_i64(dict, "kCGWindowNumber").unwrap_or_default() as u64,
                owner_pid,
                bundle_identifier,
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
                screenshot_data_url: None,
                screenshot_error: None,
                accessibility_truncated: false,
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

fn running_app_bundle_identifier(owner_pid: u32) -> Option<String> {
    if owner_pid == 0 {
        return None;
    }
    unsafe {
        let class_name = CString::new("NSRunningApplication").ok()?;
        let class = objc_getClass(class_name.as_ptr());
        if class.is_null() {
            return None;
        }
        let app = objc_msg_send(
            class as ObjcId,
            objc_selector("runningApplicationWithProcessIdentifier:")?,
            owner_pid as c_int,
        );
        if app.is_null() {
            return None;
        }
        let bundle_identifier = objc_msg_send(app, objc_selector("bundleIdentifier")?);
        if bundle_identifier.is_null() {
            return None;
        }
        let value = objc_msg_send(bundle_identifier, objc_selector("UTF8String")?) as *const c_char;
        if value.is_null() {
            return None;
        }
        CStr::from_ptr(value).to_str().ok().and_then(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        })
    }
}

unsafe fn objc_selector(name: &str) -> Option<ObjcSel> {
    let name = CString::new(name).ok()?;
    let selector = sel_registerName(name.as_ptr());
    (!selector.is_null()).then_some(selector)
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
type Sqlite3 = c_void;
type Sqlite3Stmt = c_void;
type ObjcClass = *const c_void;
type ObjcId = *const c_void;
type ObjcSel = *const c_void;

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

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_CF_NUMBER_SINT64_TYPE: c_int = 4;
const K_CF_NUMBER_DOUBLE_TYPE: c_int = 13;
const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: c_uint = 1;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: c_uint = 16;
const K_CG_HID_EVENT_TAP: c_uint = 0;
const K_CG_EVENT_LEFT_MOUSE_DOWN: c_uint = 1;
const K_CG_EVENT_LEFT_MOUSE_UP: c_uint = 2;
const K_CG_EVENT_MOUSE_MOVED: c_uint = 5;
const K_CG_EVENT_LEFT_MOUSE_DRAGGED: c_uint = 6;
const K_CG_MOUSE_EVENT_CLICK_STATE: c_uint = 1;
const K_CG_MOUSE_BUTTON_LEFT: c_uint = 0;
const K_CG_SCROLL_EVENT_UNIT_LINE: c_uint = 1;
const K_AX_ERROR_SUCCESS: c_int = 0;
const K_AX_VALUE_CGPOINT_TYPE: c_int = 1;
const K_AX_VALUE_CGSIZE_TYPE: c_int = 2;
const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_OPEN_READONLY: c_int = 1;

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> ObjcClass;
    fn sel_registerName(name: *const c_char) -> ObjcSel;
    #[link_name = "objc_msgSend"]
    fn objc_msg_send(receiver: ObjcId, selector: ObjcSel, ...) -> ObjcId;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> c_uchar;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> c_uchar;
    fn AXUIElementCreateApplication(pid: c_int) -> AXUIElementRef;
    fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: c_float,
        y: c_float,
        element: *mut AXUIElementRef,
    ) -> c_int;
    fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFArrayRef) -> c_int;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> c_int;
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut c_uchar,
    ) -> c_int;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> c_int;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> c_int;
    fn AXValueGetValue(value: AXValueRef, value_type: c_int, output: *mut c_void) -> c_uchar;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGMainDisplayID() -> c_uint;
    fn CGDisplayBounds(display: c_uint) -> CGRect;
    fn CGEventCreate(source: CGEventSourceRef) -> CGEventRef;
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
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
    fn CGEventSetLocation(event: CGEventRef, location: CGPoint);
    fn CGEventSetIntegerValueField(event: CGEventRef, field: c_uint, value: i64);
    fn CGEventPost(tap: c_uint, event: CGEventRef);
    fn CGEventPostToPid(pid: c_int, event: CGEventRef);
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
    fn CFArrayCreate(
        allocator: *const c_void,
        values: *const CFTypeRef,
        num_values: CFIndex,
        callbacks: *const c_void,
    ) -> CFArrayRef;
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

#[link(name = "sqlite3")]
extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        database: *mut *mut Sqlite3,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(database: *mut Sqlite3) -> c_int;
    fn sqlite3_prepare_v2(
        database: *mut Sqlite3,
        query: *const c_char,
        byte_count: c_int,
        statement: *mut *mut Sqlite3Stmt,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_bind_text(
        statement: *mut Sqlite3Stmt,
        index: c_int,
        value: *const c_char,
        byte_count: c_int,
        destructor: Option<unsafe extern "C" fn(*mut c_void)>,
    ) -> c_int;
    fn sqlite3_bind_int(statement: *mut Sqlite3Stmt, index: c_int, value: c_int) -> c_int;
    fn sqlite3_step(statement: *mut Sqlite3Stmt) -> c_int;
    fn sqlite3_column_int(statement: *mut Sqlite3Stmt, column: c_int) -> c_int;
    fn sqlite3_finalize(statement: *mut Sqlite3Stmt) -> c_int;
}
