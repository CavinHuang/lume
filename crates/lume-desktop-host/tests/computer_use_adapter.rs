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
            "list_apps" => Ok(json!({
                "status": "ok",
                "apps": [{
                    "id": "D:\\software\\Tencent\\Weixin\\Weixin.exe",
                    "name": "微信",
                    "displayName": "微信",
                    "isRunning": true,
                    "windows": [platform_window()]
                }]
            })),
            "list_windows" => Ok(json!({ "status": "ok", "windows": [platform_window()] })),
            "get_window" => Ok(json!({ "status": "ok", "window": platform_window() })),
            "get_window_state" => Ok(json!({
                "status": "ok",
                "window": platform_window(),
                "capturedAt": 10,
                "accessibility": {
                    "tree": [{
                        "id": "root.0",
                        "role": "edit",
                        "name": "输入",
                        "value": "草稿",
                        "bounds": { "x": 120, "y": 500, "width": 400, "height": 80 },
                        "focused": true,
                        "settable": true,
                        "actions": ["Invoke"],
                        "children": []
                    }],
                    "focusedElement": {
                        "id": "root.0",
                        "role": "edit",
                        "name": "输入",
                        "focused": true,
                        "settable": true
                    },
                    "selectedText": "选择",
                    "documentText": "真实聊天",
                    "visibleText": "真实聊天"
                },
                "screenshots": [{
                    "id": "platform-shot",
                    "mimeType": "image/png",
                    "width": 800,
                    "height": 600,
                    "physicalWidth": 1000,
                    "physicalHeight": 750,
                    "captureLeft": 100,
                    "captureTop": 50,
                    "origin": { "x": 0, "y": 0 },
                    "zIndex": 0,
                    "dataUrl": "data:image/png;base64,ZmFrZQ=="
                }]
            })),
            "preflight_action" => Ok(json!({
                "status": "ok",
                "role": "button",
                "name": "发送消息",
                "sensitive": false
            })),
            _ => Ok(json!({ "status": "ok" })),
        }
    }
}

fn platform_window() -> Value {
    json!({
        "id": "win:42",
        "appId": "D:\\software\\Tencent\\Weixin\\Weixin.exe",
        "appName": "微信",
        "title": "小树懒",
        "focused": true,
        "dpi": 120,
        "bounds": { "x": 100, "y": 50, "width": 800, "height": 600 }
    })
}

fn window() -> Value {
    json!({
        "id": 42,
        "app": "D:\\software\\Tencent\\Weixin\\Weixin.exe",
        "title": "小树懒"
    })
}

#[test]
fn returns_window2_arrays_and_rehydrates_by_id() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();

    let windows = adapter
        .invoke(&backend, "list_windows", &json!({}))
        .unwrap();
    assert_eq!(windows, json!([window()]));

    let apps = adapter.invoke(&backend, "list_apps", &json!({})).unwrap();
    assert_eq!(
        apps,
        json!([{
            "id": "D:\\software\\Tencent\\Weixin\\Weixin.exe",
            "displayName": "微信",
            "isRunning": true,
            "windows": [window()]
        }])
    );

    let rehydrated = adapter
        .invoke(
            &backend,
            "get_window",
            &json!({ "id": 42, "app": "D:\\software\\Tencent\\Weixin\\Weixin.exe" }),
        )
        .unwrap();
    assert_eq!(rehydrated, window());
}

#[test]
fn defaults_to_screenshot_without_accessibility_text() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let state = adapter
        .invoke(&backend, "get_window_state", &json!({ "window": window() }))
        .unwrap();

    assert_eq!(state["window"], window());
    assert!(state["accessibility"].is_null());
    assert!(state["screenshots"][0]["id"]
        .as_str()
        .unwrap()
        .starts_with("screenshot:42:"));
    assert_eq!(
        state["screenshots"][0]["url"],
        "data:image/png;base64,ZmFrZQ=="
    );
    assert_eq!(state["screenshots"][0]["originX"], 0);
    assert_eq!(state["screenshots"][0]["originY"], 0);
    assert!(state.get("status").is_none());
    assert!(state.get("stateId").is_none());

    let call = backend.calls().last().unwrap().clone();
    assert_eq!(call.0, "get_window_state");
    assert_eq!(call.1["includeScreenshot"], true);
}

#[test]
fn emits_a_codex_style_indexed_accessibility_tree_when_requested() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let state = adapter
        .invoke(
            &backend,
            "get_window_state",
            &json!({
                "window": window(),
                "include_screenshot": false,
                "include_text": true
            }),
        )
        .unwrap();

    assert_eq!(state["screenshots"], json!([]));
    let tree = state["accessibility"]["tree"].as_str().unwrap();
    assert!(tree.starts_with("Window: \"小树懒\", App: 微信."));
    assert!(tree.contains("0 edit 输入"));
    assert!(tree.contains("value=\"草稿\""));
    assert!(tree.contains("bounds=(16,360,320,64)"));
    assert_eq!(
        state["accessibility"]["focused_element"],
        "0 edit 输入 (focused)"
    );
    assert_eq!(state["accessibility"]["selected_text"], "选择");
    assert_eq!(state["accessibility"]["document_text"], "真实聊天");
}

#[test]
fn resolves_latest_element_indexes_without_a_public_state_id() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    adapter
        .invoke(
            &backend,
            "get_window_state",
            &json!({
                "window": window(),
                "include_screenshot": false,
                "include_text": true
            }),
        )
        .unwrap();

    let result = adapter
        .invoke(
            &backend,
            "click",
            &json!({ "window": window(), "element_index": 0 }),
        )
        .unwrap();

    assert!(result.is_null());
    let call = backend.calls().last().unwrap().clone();
    assert_eq!(call.0, "click");
    assert_eq!(call.1["elementId"], "root.0");
}

#[test]
fn translates_window_relative_coordinates_and_action_parameters() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let result = adapter
        .invoke(
            &backend,
            "click",
            &json!({
                "window": window(),
                "x": 20,
                "y": 30,
                "click_count": 2,
                "mouse_button": "left"
            }),
        )
        .unwrap();

    assert!(result.is_null());
    let call = backend.calls().last().unwrap().clone();
    assert_eq!(call.1["x"], 125);
    assert_eq!(call.1["y"], 88);
    assert_eq!(call.1["clickCount"], 2);
    assert_eq!(call.1["mouseButton"], "left");
    assert!(call.1.get("click_count").is_none());
}

#[test]
fn rejects_screenshot_ids_after_a_new_capture_for_the_window() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let first = adapter
        .invoke(&backend, "get_window_state", &json!({ "window": window() }))
        .unwrap();
    let first_id = first["screenshots"][0]["id"].as_str().unwrap().to_owned();
    let second = adapter
        .invoke(&backend, "get_window_state", &json!({ "window": window() }))
        .unwrap();
    let second_id = second["screenshots"][0]["id"].as_str().unwrap().to_owned();
    assert_ne!(first_id, second_id);

    let stale = adapter.invoke(
        &backend,
        "click",
        &json!({ "window": window(), "screenshotId": first_id, "x": 1, "y": 1 }),
    );
    assert!(stale.unwrap_err().to_string().contains("screenshot"));
}

#[test]
fn uses_the_cached_capture_transform_for_screenshot_coordinates() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let state = adapter
        .invoke(&backend, "get_window_state", &json!({ "window": window() }))
        .unwrap();
    let screenshot_id = state["screenshots"][0]["id"].as_str().unwrap();

    adapter
        .invoke(
            &backend,
            "click",
            &json!({
                "window": window(),
                "screenshotId": screenshot_id,
                "x": 400,
                "y": 300
            }),
        )
        .unwrap();
    let call = backend.calls().last().unwrap().clone();
    assert_eq!(call.1["x"], 600);
    assert_eq!(call.1["y"], 425);
}

#[test]
fn resolves_private_action_preflight_without_public_target_labels() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    adapter
        .invoke(
            &backend,
            "get_window_state",
            &json!({ "window": window(), "include_screenshot": false, "include_text": true }),
        )
        .unwrap();

    let element = adapter
        .invoke(
            &backend,
            "desktop_context.preflight_action",
            &json!({ "action": "click", "window": window(), "element_index": 0 }),
        )
        .unwrap();
    assert_eq!(element["targetLabel"], "输入");
    assert_eq!(element["role"], "edit");

    let point = adapter
        .invoke(
            &backend,
            "desktop_context.preflight_action",
            &json!({ "action": "click", "window": window(), "x": 10, "y": 20 }),
        )
        .unwrap();
    assert_eq!(point["targetLabel"], "发送消息");
    let call = backend.calls().last().unwrap().clone();
    assert_eq!(call.0, "preflight_action");
    assert_eq!(call.1["x"], 113);
    assert_eq!(call.1["y"], 75);
}

#[test]
fn stale_window_can_observe_but_must_use_the_returned_canonical_window_for_preflight() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let stale_window = json!({ "id": 42, "app": "Weixin.exe", "title": "小树懒" });

    let state = adapter
        .invoke(
            &backend,
            "get_window_state",
            &json!({ "window": stale_window, "include_screenshot": false }),
        )
        .unwrap();
    assert_eq!(state["window"], window());

    let error = adapter
        .invoke(
            &backend,
            "desktop_context.preflight_action",
            &json!({ "action": "click", "window": stale_window, "x": 10, "y": 20 }),
        )
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "stale_target: window identity changed before action preflight; use the latest state.window"
    );
}

#[test]
fn stale_window_dispatch_fails_until_the_returned_canonical_window_is_used() {
    let backend = FakeBackend::new();
    let mut adapter = ComputerUseProtocolAdapter::new();
    let stale_window = json!({ "id": 42, "app": "Weixin.exe", "title": "小树懒" });

    let error = adapter
        .invoke(
            &backend,
            "click",
            &json!({ "window": stale_window, "x": 10, "y": 20 }),
        )
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "stale_target: window identity changed before dispatch; use the latest state.window"
    );

    let result = adapter
        .invoke(
            &backend,
            "click",
            &json!({ "window": window(), "x": 10, "y": 20 }),
        )
        .unwrap();
    assert!(result.is_null());
}
