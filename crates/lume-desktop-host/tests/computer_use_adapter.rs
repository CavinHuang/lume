use anyhow::Result;
use lume_desktop_host::{ComputerUseProtocolAdapter, DesktopBackend};
use serde_json::{json, Value};
use std::sync::Mutex;

struct FakeBackend {
    calls: Mutex<Vec<(String, Value)>>,
}

impl FakeBackend {
    fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

impl DesktopBackend for FakeBackend {
    fn invoke(&self, method: &str, params: &Value) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_owned(), params.clone()));
        match method {
            "list_windows" => Ok(json!({
                "status": "ok",
                "windows": [{
                    "id": "win:42",
                    "appId": "wechat.exe",
                    "appName": "微信",
                    "title": "小树懒",
                    "focused": true,
                    "bounds": { "x": 100, "y": 50, "width": 800, "height": 600 }
                }]
            })),
            "get_window" => Ok(json!({
                "status": "ok",
                "window": {
                    "id": "win:42",
                    "appId": "wechat.exe",
                    "appName": "微信",
                    "title": "小树懒",
                    "focused": true,
                    "bounds": { "x": 100, "y": 50, "width": 800, "height": 600 }
                }
            })),
            "get_window_state" => Ok(json!({
                "status": "ok",
                "window": {
                    "id": "win:42",
                    "appId": "wechat.exe",
                    "appName": "微信",
                    "title": "小树懒",
                    "focused": true,
                    "bounds": { "x": 100, "y": 50, "width": 800, "height": 600 }
                },
                "capturedAt": 10,
                "accessibility": {
                    "tree": [{
                        "id": "root.0",
                        "role": "edit",
                        "name": "输入",
                        "bounds": { "x": 120, "y": 500, "width": 400, "height": 80 },
                        "focused": true,
                        "settable": true,
                        "children": []
                    }],
                    "focusedElement": { "id": "root.0", "role": "edit", "focused": true, "settable": true },
                    "selectedText": "选择",
                    "documentText": "真实聊天",
                    "visibleText": "真实聊天"
                },
                "screenshots": [{
                    "id": "geometry-derived",
                    "mimeType": "image/png",
                    "width": 1600,
                    "height": 1200,
                    "dataUrl": "data:image/png;base64,ZmFrZQ=="
                }]
            })),
            _ => Ok(json!({ "status": "ok" })),
        }
    }
}

fn window() -> Value {
    json!({ "id": 42, "app": "微信", "title": "小树懒" })
}

#[test]
fn maps_platform_windows_to_the_canonical_contract() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let result = adapter
        .invoke(&backend, "list_windows", &json!({}))
        .unwrap();

    assert_eq!(
        result["windows"],
        json!([{ "id": 42, "app": "微信", "title": "小树懒" }])
    );
}

#[test]
fn emits_element_indices_and_resolves_them_only_against_the_matching_state() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let state = adapter
        .invoke(&backend, "get_window_state", &json!({ "window": window() }))
        .unwrap();
    let state_id = state["stateId"].as_str().unwrap();

    assert_eq!(state["window"], window());
    assert_eq!(state["focused"], true);
    assert_eq!(state["accessibility"]["tree"][0]["element_index"], 0);
    assert_eq!(state["accessibility"]["tree"][0]["bounds"]["x"], 20);
    assert_eq!(state["accessibility"]["focused_element"]["editable"], true);
    assert_eq!(state["accessibility"]["document_text"], "真实聊天");
    assert!(state.get("screenshots").is_none());

    let result = adapter
        .invoke(
            &backend,
            "click",
            &json!({
                "window": window(),
                "stateId": state_id,
                "element_index": 0
            }),
        )
        .unwrap();
    assert_eq!(result["status"], "ok");
    assert_eq!(backend.calls().last().unwrap().1["elementId"], "root.0");

    let stale = adapter
        .invoke(
            &backend,
            "click",
            &json!({
                "window": window(),
                "stateId": "state:stale",
                "element_index": 0
            }),
        )
        .unwrap();
    assert_eq!(stale["status"], "stale_target");
}

#[test]
fn translates_window_relative_coordinates_to_platform_coordinates() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let result = adapter
        .invoke(
            &backend,
            "click",
            &json!({
                "window": window(),
                "x": 20,
                "y": 30
            }),
        )
        .unwrap();

    assert_eq!(result["status"], "ok");
    let call = backend.calls().last().unwrap().clone();
    assert_eq!(call.0, "click");
    assert_eq!(call.1["x"], 120);
    assert_eq!(call.1["y"], 80);
}

#[test]
fn issues_unique_screenshot_ids_and_rejects_cross_window_reuse() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let first = adapter
        .invoke(&backend, "take_screenshot", &json!({ "window": window() }))
        .unwrap();
    let second = adapter
        .invoke(&backend, "take_screenshot", &json!({ "window": window() }))
        .unwrap();
    let first_id = first["screenshots"][0]["id"].as_str().unwrap();
    let second_id = second["screenshots"][0]["id"].as_str().unwrap();
    assert_ne!(first_id, second_id);

    let stale = adapter
        .invoke(
            &backend,
            "click",
            &json!({
                "window": { "id": 99, "app": "其他" },
                "screenshotId": second_id,
                "x": 1,
                "y": 1
            }),
        )
        .unwrap();
    assert_eq!(stale["status"], "stale_target");
}
