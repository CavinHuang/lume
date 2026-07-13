#![cfg(windows)]

use std::{
    fs,
    path::PathBuf,
    process::{Child, Command},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use lume_desktop_host::{windows_backend::WindowsDesktopBackend, ComputerUseProtocolAdapter};
use serde_json::{json, Value};

const FIXTURE_TITLE: &str = "Lume Computer Use Fixture";
const OCCLUDER_TITLE: &str = "Lume Computer Use Occluder";

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
    let mut adapter = ComputerUseProtocolAdapter::new();
    let window = wait_for_window(&mut adapter, &backend, Duration::from_secs(15));

    let state = adapter
        .invoke(
            &backend,
            "get_window_state",
            &json!({ "window": window, "include_screenshot": true, "include_text": true }),
        )
        .unwrap();
    assert!(state["screenshots"][0]["url"]
        .as_str()
        .is_some_and(|value| value.starts_with("data:image/png;base64,")));
    let baseline_screenshot_len = state["screenshots"][0]["url"].as_str().unwrap().len();
    let tree = state["accessibility"]["tree"].as_str().unwrap();
    let button = find_element(tree, "Increment Counter");
    let input = find_element(tree, "Fixture Input");
    let scroll = find_element(tree, "Fixture Scroll");
    let drag_pad = find_element(tree, "Fixture Drag Pad");
    let mut occluder = ChildProcess::spawn_occluder();
    wait_for_window_title(
        &mut adapter,
        &backend,
        OCCLUDER_TITLE,
        Duration::from_secs(15),
    );
    let occluded_state = adapter
        .invoke(
            &backend,
            "get_window_state",
            &json!({ "window": window, "include_screenshot": true, "include_text": false }),
        )
        .unwrap();
    assert_eq!(occluded_state["window"], window);
    let occluded_screenshot_len = occluded_state["screenshots"][0]["url"]
        .as_str()
        .unwrap()
        .len();
    assert!(
        baseline_screenshot_len.abs_diff(occluded_screenshot_len) < baseline_screenshot_len / 5,
        "occluded WGC capture should retain the target window pixels"
    );
    occluder.stop();

    let clicked = adapter
        .invoke(
            &backend,
            "click",
            &json!({
                "window": window,
                "element_index": button.index,
            }),
        )
        .unwrap();
    assert!(clicked.is_null());
    wait_for_fixture_state(&fixture.state_path, "button click", |state| {
        state["counter"] == 1
    });

    let set = adapter
        .invoke(
            &backend,
            "set_value",
            &json!({
                "window": window,
                "element_index": input.index,
                "value": "set-value-ok",
            }),
        )
        .unwrap();
    assert!(set.is_null());
    wait_for_fixture_state(&fixture.state_path, "set value", |state| {
        state["text"] == "set-value-ok"
    });
    let set_state = adapter
        .invoke(
            &backend,
            "get_window_state",
            &json!({ "window": window, "include_screenshot": false, "include_text": true }),
        )
        .unwrap();
    assert!(set_state["accessibility"]["tree"]
        .as_str()
        .is_some_and(|tree| tree.contains("value=\"set-value-ok\"")));

    adapter
        .invoke(
            &backend,
            "click",
            &json!({ "window": window, "element_index": input.index }),
        )
        .unwrap();
    let typed = adapter
        .invoke(
            &backend,
            "type_text",
            &json!({
                "window": window,
                "text": "-typed",
            }),
        )
        .unwrap();
    assert!(typed.is_null());
    wait_for_fixture_state(&fixture.state_path, "type text", |state| {
        state["text"] == "set-value-ok-typed"
    });

    let scrolled = adapter
        .invoke(
            &backend,
            "scroll",
            &json!({
                "window": window,
                "x": scroll.center_x(),
                "y": scroll.center_y(),
                "scrollX": 0,
                "scrollY": 120,
            }),
        )
        .unwrap();
    assert!(scrolled.is_null());
    wait_for_fixture_state(&fixture.state_path, "scroll", |state| {
        state["scroll"].as_i64().unwrap_or_default() > 0
    });

    let dragged = adapter
        .invoke(
            &backend,
            "drag",
            &json!({
                "window": window,
                "from_x": drag_pad.center_x() - 80,
                "from_y": drag_pad.center_y(),
                "to_x": drag_pad.center_x() + 80,
                "to_y": drag_pad.center_y(),
            }),
        )
        .unwrap();
    assert!(dragged.is_null());
    wait_for_fixture_state(&fixture.state_path, "drag", |state| {
        state["lastDrag"] != "none"
    });

    fixture.stop();
}

struct FixtureProcess {
    child: Child,
    state_path: PathBuf,
}

struct ChildProcess {
    child: Child,
}

impl ChildProcess {
    fn spawn_occluder() -> Self {
        let script = format!(
            concat!(
                "Add-Type -AssemblyName System.Windows.Forms; ",
                "Add-Type -AssemblyName System.Drawing; ",
                "$form = New-Object System.Windows.Forms.Form; $form.Text = '{}'; ",
                "$form.Size = New-Object System.Drawing.Size(680, 620); ",
                "$form.StartPosition = 'CenterScreen'; ",
                "$form.TopMost = $true; ",
                "$form.BackColor = [System.Drawing.Color]::Fuchsia; ",
                "[System.Windows.Forms.Application]::Run($form)"
            ),
            OCCLUDER_TITLE
        );
        let child = Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-STA", "-Command"])
            .arg(script)
            .spawn()
            .expect("spawn Windows occluder");
        Self { child }
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        self.stop();
    }
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

fn wait_for_window(
    adapter: &mut ComputerUseProtocolAdapter,
    backend: &WindowsDesktopBackend,
    timeout: Duration,
) -> Value {
    wait_for_window_title(adapter, backend, FIXTURE_TITLE, timeout)
}

fn wait_for_window_title(
    adapter: &mut ComputerUseProtocolAdapter,
    backend: &WindowsDesktopBackend,
    title: &str,
    timeout: Duration,
) -> Value {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let windows = adapter.invoke(backend, "list_windows", &json!({})).unwrap();
        if let Some(window) = windows
            .as_array()
            .and_then(|windows| windows.iter().find(|window| window["title"] == title))
        {
            return window.clone();
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!("fixture window did not appear: {title}");
}

#[derive(Clone, Copy)]
struct Element {
    index: u64,
    bounds: (i64, i64, i64, i64),
}

impl Element {
    fn center_x(self) -> i64 {
        self.bounds.0 + self.bounds.2 / 2
    }

    fn center_y(self) -> i64 {
        self.bounds.1 + self.bounds.3 / 2
    }
}

fn find_element(tree: &str, name: &str) -> Element {
    let line = tree
        .lines()
        .find(|line| line.contains(name))
        .unwrap_or_else(|| panic!("missing fixture element {name}"));
    let index = line
        .trim_start()
        .split_whitespace()
        .next()
        .and_then(|value| value.parse().ok())
        .expect("element line must start with its index");
    let bounds = line
        .split("bounds=(")
        .nth(1)
        .and_then(|value| value.split(')').next())
        .map(|value| {
            value
                .split(',')
                .map(|part| part.parse::<i64>().expect("numeric element bounds"))
                .collect::<Vec<_>>()
        })
        .filter(|parts| parts.len() == 4)
        .map(|parts| (parts[0], parts[1], parts[2], parts[3]))
        .expect("fixture element must expose logical bounds");
    Element { index, bounds }
}

fn wait_for_fixture_state(path: &PathBuf, step: &str, predicate: impl Fn(&Value) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut last_state = None;
    while Instant::now() < deadline {
        if let Ok(data) = fs::read(path) {
            if let Ok(state) = serde_json::from_slice::<Value>(&data) {
                if predicate(&state) {
                    return;
                }
                last_state = Some(state);
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("fixture state did not reach {step}: {last_state:?}");
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
