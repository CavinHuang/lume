use lume_desktop_host::macos_fixture_protocol::{
    fixture_command, fixture_window, MacOSFixtureState,
};
use serde_json::json;

#[test]
fn maps_fixture_state_to_stable_macos_window_and_elements() {
    let state: MacOSFixtureState = serde_json::from_value(json!({
        "revision": 7,
        "processId": 42,
        "counter": 2,
        "text": "draft",
        "lastKey": "Return",
        "scrollOffset": 120,
        "lastDrag": "from (30, 30) to (290, 90)",
        "focusedElement": "input"
    }))
    .unwrap();

    let window = fixture_window(&state);

    assert_eq!(window.window_id, 4_242);
    assert_eq!(window.owner_pid, 42);
    assert_eq!(
        window.bundle_identifier.as_deref(),
        Some("com.lume.computer-use.fixture")
    );
    assert_eq!(window.owner_name, "Lume Computer Use Fixture");
    assert_eq!(window.title, "Lume Computer Use Fixture");
    assert_eq!(window.elements[0].title, "Increment Counter");
    assert_eq!(window.elements[0].actions, vec!["AXPress".to_owned()]);
    assert_eq!(window.elements[1].value, "Counter: 2");
    assert_eq!(window.elements[2].title, "Fixture Input");
    assert_eq!(window.elements[2].value, "draft");
    assert!(window.elements[2].focused);
    assert!(window.elements[2].settable);
    assert_eq!(window.elements[4].value, "Last key: Return");
    assert_eq!(window.elements[6].value, "Scroll offset: 120");
    assert_eq!(
        window.elements[8].value,
        "Last drag: from (30, 30) to (290, 90)"
    );
    assert!(window
        .screenshot_data_url
        .as_deref()
        .is_some_and(|value| value.starts_with("data:image/png;base64,")));
}

#[test]
fn creates_non_sensitive_fixture_commands_with_lume_parameter_names() {
    let command = fixture_command(
        19,
        "drag",
        &json!({
            "windowId": "macos:4242",
            "fromX": 30,
            "fromY": 40,
            "toX": 250,
            "toY": 90,
        }),
    );

    assert_eq!(command["id"], 19);
    assert_eq!(command["method"], "drag");
    assert_eq!(command["params"]["fromX"], 30);
    assert_eq!(command["params"]["toY"], 90);
    assert!(command.get("state").is_none());
}
