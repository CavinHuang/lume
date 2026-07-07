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
