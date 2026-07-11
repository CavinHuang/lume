#![cfg(windows)]

use std::{
    fs,
    path::PathBuf,
    process::{Child, Command},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use lume_desktop_host::{windows_backend::WindowsDesktopBackend, DesktopBackend};
use serde_json::{json, Value};

const FIXTURE_TITLE: &str = "Lume Computer Use Fixture";

#[test]
fn drives_a_real_windows_fixture_through_uia_and_targeted_input() {
    let state_path = unique_state_path();
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("windows-computer-use-fixture.ps1");
    let child = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-STA", "-File"])
        .arg(script)
        .arg("-StatePath")
        .arg(&state_path)
        .spawn()
        .expect("spawn Windows fixture");
    let mut fixture = FixtureProcess { child, state_path };
    let backend = WindowsDesktopBackend;
    let window_id = wait_for_window(&backend, Duration::from_secs(15));

    let state = backend
        .invoke(
            "get_window_state",
            &json!({ "windowId": window_id, "includeScreenshot": true }),
        )
        .unwrap();
    assert_eq!(state["status"], "ok");
    assert!(state["screenshots"][0]["dataUrl"]
        .as_str()
        .is_some_and(|value| value.starts_with("data:image/png;base64,")));
    let button = find_element(&state["accessibility"]["tree"], "Increment Counter");
    let input = find_element(&state["accessibility"]["tree"], "Fixture Input");
    let scroll = find_element(&state["accessibility"]["tree"], "Fixture Scroll");
    let drag_pad = find_element(&state["accessibility"]["tree"], "Fixture Drag Pad");

    let clicked = backend
        .invoke(
            "click",
            &json!({
                "windowId": window_id,
                "elementId": button["id"],
                "x": center_x(button),
                "y": center_y(button),
            }),
        )
        .unwrap();
    assert_eq!(clicked["status"], "ok");
    wait_for_fixture_state(&fixture.state_path, |state| state["counter"] == 1);

    let set = backend
        .invoke(
            "set_value",
            &json!({
                "windowId": window_id,
                "elementId": input["id"],
                "value": "set-value-ok",
            }),
        )
        .unwrap();
    assert_eq!(set["status"], "ok");
    wait_for_fixture_state(&fixture.state_path, |state| state["text"] == "set-value-ok");

    let typed = backend
        .invoke(
            "type_text",
            &json!({
                "windowId": window_id,
                "elementId": input["id"],
                "text": "-typed",
            }),
        )
        .unwrap();
    assert_eq!(typed["status"], "ok");
    wait_for_fixture_state(&fixture.state_path, |state| {
        state["text"] == "set-value-ok-typed"
    });

    let scrolled = backend
        .invoke(
            "scroll",
            &json!({
                "windowId": window_id,
                "elementId": scroll["id"],
                "direction": "down",
                "pages": 1,
            }),
        )
        .unwrap();
    assert_eq!(scrolled["status"], "ok");
    wait_for_fixture_state(&fixture.state_path, |state| {
        state["scroll"].as_i64().unwrap_or_default() > 0
    });

    let dragged = backend
        .invoke(
            "drag",
            &json!({
                "windowId": window_id,
                "fromX": center_x(drag_pad) - 80,
                "fromY": center_y(drag_pad),
                "toX": center_x(drag_pad) + 80,
                "toY": center_y(drag_pad),
            }),
        )
        .unwrap();
    assert_eq!(dragged["status"], "ok");
    wait_for_fixture_state(&fixture.state_path, |state| state["lastDrag"] != "none");

    fixture.stop();
}

struct FixtureProcess {
    child: Child,
    state_path: PathBuf,
}

impl FixtureProcess {
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.state_path);
    }
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn wait_for_window(backend: &WindowsDesktopBackend, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let windows = backend.invoke("list_windows", &json!({})).unwrap();
        if let Some(window) = windows["windows"].as_array().and_then(|windows| {
            windows
                .iter()
                .find(|window| window["title"] == FIXTURE_TITLE)
        }) {
            return window["id"].as_str().unwrap().to_owned();
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!("fixture window did not appear");
}

fn find_element<'a>(tree: &'a Value, name: &str) -> &'a Value {
    for element in tree.as_array().into_iter().flatten() {
        if element["name"] == name {
            return element;
        }
        if let Some(found) = find_element_optional(&element["children"], name) {
            return found;
        }
    }
    panic!("missing fixture element {name}");
}

fn find_element_optional<'a>(tree: &'a Value, name: &str) -> Option<&'a Value> {
    for element in tree.as_array().into_iter().flatten() {
        if element["name"] == name {
            return Some(element);
        }
        if let Some(found) = find_element_optional(&element["children"], name) {
            return Some(found);
        }
    }
    None
}

fn center_x(element: &Value) -> i64 {
    element["bounds"]["x"].as_i64().unwrap() + element["bounds"]["width"].as_i64().unwrap() / 2
}

fn center_y(element: &Value) -> i64 {
    element["bounds"]["y"].as_i64().unwrap() + element["bounds"]["height"].as_i64().unwrap() / 2
}

fn wait_for_fixture_state(path: &PathBuf, predicate: impl Fn(&Value) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Ok(data) = fs::read(path) {
            if let Ok(state) = serde_json::from_slice::<Value>(&data) {
                if predicate(&state) {
                    return;
                }
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("fixture state did not reach the expected value");
}

fn unique_state_path() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "lume-computer-use-fixture-{}-{stamp}.json",
        std::process::id()
    ))
}
