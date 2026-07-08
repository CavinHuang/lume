use lume_desktop_host::macos_snapshot::{
    find_macos_window, macos_current_context_result, macos_get_window_state_result,
    macos_list_apps_result, macos_list_windows_result, MacOSWindowInfo,
};
use serde_json::json;

fn sample_windows() -> Vec<MacOSWindowInfo> {
    vec![
        MacOSWindowInfo {
            window_id: 42,
            owner_pid: 1001,
            owner_name: "微信".into(),
            title: "项目群".into(),
            x: 10.0,
            y: 20.0,
            width: 900.0,
            height: 700.0,
            layer: 0,
            is_onscreen: true,
            is_focused: true,
        },
        MacOSWindowInfo {
            window_id: 77,
            owner_pid: 1002,
            owner_name: "TextEdit".into(),
            title: "周报.rtf".into(),
            x: 200.0,
            y: 80.0,
            width: 640.0,
            height: 480.0,
            layer: 0,
            is_onscreen: true,
            is_focused: false,
        },
        MacOSWindowInfo {
            window_id: 99,
            owner_pid: 1003,
            owner_name: "Dock".into(),
            title: "Dock".into(),
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 80.0,
            layer: 25,
            is_onscreen: true,
            is_focused: false,
        },
    ]
}

#[test]
fn maps_core_graphics_windows_to_lume_window_refs() {
    let result = macos_list_windows_result(&sample_windows(), None);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["windows"].as_array().unwrap().len(), 2);
    assert_eq!(result["windows"][0]["id"], "macos:42");
    assert_eq!(result["windows"][0]["appId"], "pid:1001");
    assert_eq!(result["windows"][0]["appName"], "微信");
    assert_eq!(result["windows"][0]["title"], "项目群");
    assert_eq!(result["windows"][0]["focused"], true);
    assert_eq!(
        result["windows"][0]["bounds"],
        json!({ "x": 10, "y": 20, "width": 900, "height": 700 })
    );
}

#[test]
fn maps_unique_apps_from_visible_macos_windows() {
    let result = macos_list_apps_result(&sample_windows());

    assert_eq!(result["status"], "ok");
    assert_eq!(result["apps"].as_array().unwrap().len(), 2);
    assert_eq!(result["apps"][0]["id"], "pid:1001");
    assert_eq!(result["apps"][0]["name"], "微信");
    assert_eq!(result["apps"][0]["processId"], 1001);
}

#[test]
fn maps_frontmost_window_to_context_snapshot_without_screenshot_pixels() {
    let window = &sample_windows()[0];
    let result = macos_current_context_result(window, false);

    assert_eq!(result["status"], "ok");
    assert_eq!(
        result["snapshot"]["app"],
        json!({ "id": "pid:1001", "name": "微信", "processId": 1001 })
    );
    assert_eq!(result["snapshot"]["window"]["id"], "macos:42");
    assert_eq!(result["snapshot"]["visibleText"], "项目群");
    assert_eq!(result["snapshot"]["untrusted"], true);
    assert!(result["snapshot"]["screenshots"][0]
        .get("dataUrl")
        .is_none());
}

#[test]
fn maps_window_state_with_stable_revision_and_accessibility_fallback() {
    let window = &sample_windows()[1];
    let result = macos_get_window_state_result(window, true);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["window"]["id"], "macos:77");
    assert_eq!(result["revision"], "macos:77:周报.rtf:200:80:640:480");
    assert_eq!(result["accessibility"]["documentText"], "周报.rtf");
    assert_eq!(result["screenshots"][0]["mimeType"], "image/png");
    assert!(result["screenshots"][0].get("dataUrl").is_none());
}

#[test]
fn does_not_resolve_unknown_macos_window_ids() {
    assert_eq!(find_macos_window(&sample_windows(), "macos:404"), None);
    assert_eq!(find_macos_window(&sample_windows(), "win:42"), None);
}
