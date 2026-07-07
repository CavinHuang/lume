#![cfg(windows)]

use lume_desktop_host::{windows_backend::WindowsDesktopBackend, DesktopBackend};
use serde_json::json;

#[test]
fn lists_windows_and_apps_with_stable_status_shapes() {
    let backend = WindowsDesktopBackend;
    let windows = backend.invoke("list_windows", &json!({})).unwrap();
    assert_eq!(windows["status"], "ok");
    assert!(windows["windows"].is_array());

    let apps = backend.invoke("list_apps", &json!({})).unwrap();
    assert_eq!(apps["status"], "ok");
    assert!(apps["apps"].is_array());
}

#[test]
fn rejects_stale_or_missing_window_targets_without_side_effects() {
    let backend = WindowsDesktopBackend;
    let result = backend
        .invoke("activate_window", &json!({ "windowId": "win:0" }))
        .unwrap();
    assert_eq!(result["status"], "stale_target");
}

#[test]
fn get_window_state_returns_screenshot_metadata_without_pixels_by_default() {
    let backend = WindowsDesktopBackend;
    let result = backend.invoke("get_window_state", &json!({})).unwrap();

    assert_eq!(result["status"], "ok");
    let screenshot = &result["screenshots"][0];
    assert_eq!(screenshot["mimeType"], "image/bmp");
    assert!(screenshot["width"].as_i64().unwrap_or_default() > 0);
    assert!(screenshot["height"].as_i64().unwrap_or_default() > 0);
    assert!(screenshot.get("dataUrl").is_none());
}

#[test]
fn get_window_state_can_include_screenshot_pixels_when_requested() {
    let backend = WindowsDesktopBackend;
    let result = backend
        .invoke("get_window_state", &json!({ "includeScreenshot": true }))
        .unwrap();

    assert_eq!(result["status"], "ok");
    let data_url = result["screenshots"][0]["dataUrl"]
        .as_str()
        .unwrap_or_default();
    assert!(data_url.starts_with("data:image/bmp;base64,"));
}
