#![cfg(target_os = "macos")]

use lume_desktop_host::{
    macos_backend::MacOSDesktopBackend, macos_fixture_protocol::MacOSFixtureState, DesktopBackend,
};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const STATE_ENV: &str = "LUME_COMPUTER_USE_FIXTURE_STATE_PATH";
const COMMAND_ENV: &str = "LUME_COMPUTER_USE_FIXTURE_COMMAND_PATH";

#[test]
fn drives_the_macos_backend_through_a_deterministic_appkit_fixture() {
    let mut fixture = FixtureProcess::start();
    let backend = MacOSDesktopBackend;
    let window_id = "macos:4242";

    let apps = backend.invoke("list_apps", &json!({})).unwrap();
    assert_eq!(apps["status"], "ok");
    assert_eq!(apps["apps"][0]["name"], "Lume Computer Use Fixture");

    let windows = backend.invoke("list_windows", &json!({})).unwrap();
    assert_eq!(windows["status"], "ok");
    assert_eq!(windows["windows"][0]["id"], window_id);
    let window = backend
        .invoke("get_window", &json!({ "windowId": window_id }))
        .unwrap();
    assert!(window["window"]["title"]
        .as_str()
        .unwrap_or_default()
        .contains("seed"));

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
    assert_eq!(find_element(&state, "Increment Counter")["id"], "root.0");
    assert_eq!(find_element(&state, "Fixture Input")["id"], "root.2");

    assert_action_ok(
        &backend,
        "activate_window",
        json!({ "windowId": window_id }),
    );
    assert_action_ok(
        &backend,
        "move_pointer",
        json!({ "windowId": window_id, "x": 274, "y": 222 }),
    );

    assert_action_ok(
        &backend,
        "click",
        json!({ "windowId": window_id, "elementId": "root.0" }),
    );
    wait_for_fixture_state(&fixture.state_path, "element click", |state| {
        state.counter == 1
    });

    assert_action_ok(
        &backend,
        "click",
        json!({ "windowId": window_id, "x": 274, "y": 222 }),
    );
    wait_for_fixture_state(&fixture.state_path, "coordinate click", |state| {
        state.counter == 2
    });

    assert_action_ok(
        &backend,
        "perform_secondary_action",
        json!({ "windowId": window_id, "elementId": "root.0", "action": "AXPress" }),
    );
    wait_for_fixture_state(&fixture.state_path, "secondary action", |state| {
        state.counter == 3
    });

    assert_action_ok(
        &backend,
        "set_value",
        json!({ "windowId": window_id, "elementId": "root.2", "value": "set-value-ok" }),
    );
    wait_for_fixture_state(&fixture.state_path, "set value", |state| {
        state.text == "set-value-ok"
    });

    assert_action_ok(
        &backend,
        "type_text",
        json!({ "windowId": window_id, "elementId": "root.2", "text": "-typed" }),
    );
    wait_for_fixture_state(&fixture.state_path, "type text", |state| {
        state.text == "set-value-ok-typed"
    });

    assert_action_ok(
        &backend,
        "press_key",
        json!({ "windowId": window_id, "elementId": "root.3", "key": "Return" }),
    );
    wait_for_fixture_state(&fixture.state_path, "press key", |state| {
        state.last_key == "Return"
    });

    assert_action_ok(
        &backend,
        "scroll",
        json!({ "windowId": window_id, "elementId": "root.5", "direction": "down", "pages": 1 }),
    );
    wait_for_fixture_state(&fixture.state_path, "scroll", |state| {
        state.scroll_offset > 0
    });

    assert_action_ok(
        &backend,
        "drag",
        json!({
            "windowId": window_id,
            "fromX": 214,
            "fromY": 628,
            "toX": 474,
            "toY": 688,
        }),
    );
    wait_for_fixture_state(&fixture.state_path, "drag", |state| {
        state.last_drag != "none"
    });

    let context = backend
        .invoke("current_context", &json!({ "includeScreenshot": false }))
        .unwrap();
    assert_eq!(context["status"], "ok");
    assert!(context["snapshot"]["visibleText"]
        .as_str()
        .unwrap_or_default()
        .contains("set-value-ok-typed"));
    let waited = backend
        .invoke(
            "wait_for_state",
            &json!({
                "windowId": window_id,
                "titleContains": "set-value-ok-typed",
                "timeoutMs": 500,
            }),
        )
        .unwrap();
    assert_eq!(waited["status"], "ok");

    fixture.stop();
}

fn assert_action_ok(backend: &MacOSDesktopBackend, method: &str, params: Value) {
    let result = backend.invoke(method, &params).unwrap();
    assert_eq!(result["status"], "ok", "{method}: {result}");
    assert_eq!(result["inputMode"], "fixture_bridge");
}

fn find_element<'a>(state: &'a Value, name: &str) -> &'a Value {
    state["accessibility"]["tree"]
        .as_array()
        .unwrap()
        .iter()
        .find(|element| element["name"] == name)
        .unwrap_or_else(|| panic!("missing fixture element {name}"))
}

struct FixtureProcess {
    child: Child,
    directory: PathBuf,
    state_path: PathBuf,
}

impl FixtureProcess {
    fn start() -> Self {
        let directory = unique_fixture_directory();
        fs::create_dir_all(&directory).unwrap();
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join("macos-computer-use-fixture.swift");
        let binary = directory.join("LumeComputerUseFixture");
        let compile = Command::new("xcrun")
            .args(["swiftc", "-parse-as-library"])
            .arg(source)
            .args(["-o"])
            .arg(&binary)
            .args(["-framework", "AppKit"])
            .output()
            .expect("compile macOS fixture");
        assert!(
            compile.status.success(),
            "swiftc failed: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let state_path = directory.join("state.json");
        let command_path = directory.join("command.json");
        let child = Command::new(binary)
            .args(["--state-path"])
            .arg(&state_path)
            .args(["--command-path"])
            .arg(&command_path)
            .arg("--headless")
            .spawn()
            .expect("launch macOS fixture");
        env::set_var(STATE_ENV, &state_path);
        env::set_var(COMMAND_ENV, &command_path);
        wait_for_fixture_state(&state_path, "initial state", |state| state.text == "seed");
        Self {
            child,
            directory,
            state_path,
        }
    }

    fn stop(&mut self) {
        env::remove_var(STATE_ENV);
        env::remove_var(COMMAND_ENV);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn wait_for_fixture_state(path: &Path, step: &str, predicate: impl Fn(&MacOSFixtureState) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut last_state = None;
    while Instant::now() < deadline {
        if let Ok(data) = fs::read(path) {
            if let Ok(state) = serde_json::from_slice::<MacOSFixtureState>(&data) {
                if predicate(&state) {
                    return;
                }
                last_state = Some(state);
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("macOS fixture state did not reach {step}: {last_state:?}");
}

fn unique_fixture_directory() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "lume-computer-use-fixture-{}-{stamp}",
        std::process::id()
    ))
}
