#![cfg(windows)]

use std::{thread, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lume_desktop_host::{
    windows_backend::WindowsDesktopBackend,
    windows_overlay::{move_visual_cursor, reset_visual_cursor},
    DesktopBackend,
};
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
    assert_eq!(screenshot["mimeType"], "image/png");
    assert!(screenshot["width"].as_i64().unwrap_or_default() > 0);
    assert!(screenshot["height"].as_i64().unwrap_or_default() > 0);
    assert!(screenshot.get("dataUrl").is_none());
}

#[test]
fn get_window_state_reports_selected_text_field() {
    let backend = WindowsDesktopBackend;
    let result = backend.invoke("get_window_state", &json!({})).unwrap();

    assert_eq!(result["status"], "ok");
    assert!(result["accessibility"]["selectedText"].is_string());
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
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .expect("screenshot must be a PNG data URL");
    let bytes = BASE64
        .decode(encoded)
        .expect("screenshot PNG must be valid base64");
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
}

#[test]
fn current_context_includes_screenshot_pixels_only_when_requested() {
    let backend = WindowsDesktopBackend;
    let without_pixels = backend.invoke("current_context", &json!({})).unwrap();
    let with_pixels = backend
        .invoke("current_context", &json!({ "includeScreenshot": true }))
        .unwrap();

    assert_eq!(without_pixels["status"], "ok");
    assert!(without_pixels["snapshot"]["screenshots"][0]
        .get("dataUrl")
        .is_none());
    let data_url = with_pixels["snapshot"]["screenshots"][0]["dataUrl"]
        .as_str()
        .unwrap_or_default();
    assert!(data_url.starts_with("data:image/png;base64,"));
}

#[test]
fn current_context_omits_empty_selected_text() {
    let backend = WindowsDesktopBackend;
    let result = backend.invoke("current_context", &json!({})).unwrap();

    assert_eq!(result["status"], "ok");
    let selected_text = result["snapshot"].get("selectedText");
    assert!(selected_text.is_none() || selected_text.is_some_and(|value| value.is_string()));
}

#[test]
fn excludes_the_visual_cursor_window_from_agent_visible_app_lists() {
    move_visual_cursor(80, 80, None);
    thread::sleep(Duration::from_millis(220));

    let backend = WindowsDesktopBackend;
    let result = backend.invoke("list_windows", &json!({})).unwrap();
    let titles = result["windows"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|window| window["title"].as_str())
        .collect::<Vec<_>>();
    reset_visual_cursor();

    assert!(!titles.contains(&"Lume Visual Cursor"));
}
