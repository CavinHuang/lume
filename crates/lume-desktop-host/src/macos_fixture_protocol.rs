use crate::macos_snapshot::{MacOSElementInfo, MacOSWindowInfo};
use serde::Deserialize;
use serde_json::{json, Value};

pub const MACOS_FIXTURE_WINDOW_ID: u64 = 4_242;
pub const MACOS_FIXTURE_BUNDLE_ID: &str = "com.lume.computer-use.fixture";
pub const MACOS_FIXTURE_APP_NAME: &str = "Lume Computer Use Fixture";

const FIXTURE_PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLzWQAAAABJRU5ErkJggg==";

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacOSFixtureState {
    pub revision: u64,
    pub process_id: u32,
    pub counter: i64,
    pub text: String,
    pub last_key: String,
    pub scroll_offset: i64,
    pub last_drag: String,
    pub focused_element: Option<String>,
}

pub fn fixture_window(state: &MacOSFixtureState) -> MacOSWindowInfo {
    let document_text = format!(
        "Counter: {}\n{}\nLast key: {}\nScroll offset: {}\nLast drag: {}",
        state.counter, state.text, state.last_key, state.scroll_offset, state.last_drag
    );
    MacOSWindowInfo {
        window_id: MACOS_FIXTURE_WINDOW_ID,
        owner_pid: state.process_id,
        bundle_identifier: Some(MACOS_FIXTURE_BUNDLE_ID.to_owned()),
        owner_name: MACOS_FIXTURE_APP_NAME.to_owned(),
        title: MACOS_FIXTURE_APP_NAME.to_owned(),
        x: 160.0,
        y: 180.0,
        width: 640.0,
        height: 620.0,
        layer: 0,
        is_onscreen: true,
        is_focused: true,
        document_text: Some(document_text),
        selected_text: None,
        screenshot_data_url: Some(FIXTURE_PNG_DATA_URL.to_owned()),
        screenshot_error: None,
        accessibility_truncated: false,
        elements: fixture_elements(state),
    }
}

pub fn fixture_command(id: u64, method: &str, params: &Value) -> Value {
    json!({
        "id": id,
        "method": method,
        "params": params,
    })
}

fn fixture_elements(state: &MacOSFixtureState) -> Vec<MacOSElementInfo> {
    vec![
        element_with_actions(
            "AXButton",
            "Increment Counter",
            "",
            184.0,
            204.0,
            180.0,
            36.0,
            vec!["AXPress".to_owned()],
        ),
        element(
            "AXStaticText",
            "Counter",
            &format!("Counter: {}", state.counter),
            184.0,
            250.0,
            240.0,
            28.0,
        ),
        editable_element(state),
        focused_element(
            "AXGroup",
            "Fixture Key Capture",
            184.0,
            330.0,
            320.0,
            72.0,
            state.focused_element.as_deref() == Some("key"),
        ),
        element(
            "AXStaticText",
            "Last Key",
            &format!("Last key: {}", state.last_key),
            184.0,
            412.0,
            320.0,
            28.0,
        ),
        element_with_actions(
            "AXScrollArea",
            "Fixture Scroll",
            "",
            184.0,
            450.0,
            520.0,
            100.0,
            vec!["AXScrollDown".to_owned(), "AXScrollUp".to_owned()],
        ),
        element(
            "AXStaticText",
            "Scroll Status",
            &format!("Scroll offset: {}", state.scroll_offset),
            184.0,
            560.0,
            320.0,
            28.0,
        ),
        element(
            "AXGroup",
            "Fixture Drag Pad",
            "",
            184.0,
            598.0,
            320.0,
            120.0,
        ),
        element(
            "AXStaticText",
            "Drag Status",
            &format!("Last drag: {}", state.last_drag),
            184.0,
            728.0,
            440.0,
            28.0,
        ),
    ]
}

fn editable_element(state: &MacOSFixtureState) -> MacOSElementInfo {
    let mut element = focused_element(
        "AXTextField",
        "Fixture Input",
        184.0,
        288.0,
        320.0,
        30.0,
        state.focused_element.as_deref() == Some("input"),
    );
    element.value = state.text.clone();
    element.settable = true;
    element.actions = vec!["AXConfirm".to_owned()];
    element
}

fn element(
    role: &str,
    title: &str,
    value: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> MacOSElementInfo {
    let mut element = focused_element(role, title, x, y, width, height, false);
    element.value = value.to_owned();
    element
}

fn element_with_actions(
    role: &str,
    title: &str,
    value: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    actions: Vec<String>,
) -> MacOSElementInfo {
    let mut element = element(role, title, value, x, y, width, height);
    element.actions = actions;
    element
}

fn focused_element(
    role: &str,
    title: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    focused: bool,
) -> MacOSElementInfo {
    MacOSElementInfo {
        role: role.to_owned(),
        title: title.to_owned(),
        value: String::new(),
        x,
        y,
        width,
        height,
        enabled: true,
        focused,
        sensitive: false,
        settable: false,
        actions: Vec::new(),
        children: Vec::new(),
    }
}
