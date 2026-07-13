use crate::{
    macos_fixture_protocol::{fixture_command, fixture_window, MacOSFixtureState},
    macos_snapshot::{
        macos_current_context_result, macos_get_window_result, macos_get_window_state_result,
        macos_list_apps_result, macos_list_windows_result,
    },
};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const STATE_PATH_ENV: &str = "LUME_COMPUTER_USE_FIXTURE_STATE_PATH";
const COMMAND_PATH_ENV: &str = "LUME_COMPUTER_USE_FIXTURE_COMMAND_PATH";

pub fn invoke(method: &str, params: &Value) -> Result<Option<Value>> {
    let Some(paths) = FixturePaths::from_environment() else {
        return Ok(None);
    };
    let state = read_state(&paths.state)?;
    let window = fixture_window(&state);
    let result = match method {
        "diagnose_permissions" | "request_permissions" => json!({
            "status": "ok",
            "permissions": [
                { "id": "accessibility", "status": "granted" },
                { "id": "screenRecording", "status": "granted" },
            ],
        }),
        "list_apps" => macos_list_apps_result(std::slice::from_ref(&window)),
        "list_windows" => macos_list_windows_result(
            std::slice::from_ref(&window),
            params.get("appId").and_then(Value::as_str),
        ),
        "get_window" => {
            if valid_optional_window(params) {
                macos_get_window_result(Some(window))
            } else {
                stale_target()
            }
        }
        "current_context" => macos_current_context_result(
            &window,
            params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
        ),
        "get_window_state" => {
            if valid_optional_window(params) {
                macos_get_window_state_result(
                    &window,
                    params.get("includeScreenshot").and_then(Value::as_bool) == Some(true),
                )
            } else {
                stale_target()
            }
        }
        "activate_window"
        | "move_pointer"
        | "click"
        | "perform_secondary_action"
        | "scroll"
        | "drag"
        | "press_key"
        | "type_text"
        | "set_value" => {
            if !valid_required_window(params) {
                stale_target()
            } else {
                write_command(&paths.command, method, params)?;
                json!({
                    "status": "ok",
                    "inputMode": "fixture_bridge",
                    "visualPointer": "software_overlay",
                })
            }
        }
        _ => json!({
            "status": "unavailable",
            "message": format!("desktop method is not implemented by the macOS fixture: {method}"),
        }),
    };
    Ok(Some(result))
}

struct FixturePaths {
    state: PathBuf,
    command: PathBuf,
}

impl FixturePaths {
    fn from_environment() -> Option<Self> {
        Some(Self {
            state: PathBuf::from(env::var_os(STATE_PATH_ENV)?),
            command: PathBuf::from(env::var_os(COMMAND_PATH_ENV)?),
        })
    }
}

fn read_state(path: &Path) -> Result<MacOSFixtureState> {
    let data = fs::read(path)
        .with_context(|| format!("read macOS fixture state from {}", path.display()))?;
    serde_json::from_slice(&data).context("decode macOS fixture state")
}

fn write_command(path: &Path, method: &str, params: &Value) -> Result<()> {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u128::from(u64::MAX)) as u64;
    let data = serde_json::to_vec(&fixture_command(id, method, params))?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, data)
        .with_context(|| format!("write macOS fixture command to {}", temporary.display()))?;
    fs::rename(&temporary, path)
        .with_context(|| format!("publish macOS fixture command to {}", path.display()))?;
    Ok(())
}

fn valid_optional_window(params: &Value) -> bool {
    params
        .get("windowId")
        .and_then(Value::as_str)
        .is_none_or(|window_id| window_id == "macos:4242")
}

fn valid_required_window(params: &Value) -> bool {
    params.get("windowId").and_then(Value::as_str) == Some("macos:4242")
}

fn stale_target() -> Value {
    json!({
        "status": "stale_target",
        "message": "target window is unavailable",
    })
}
