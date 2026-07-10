use anyhow::Result;
use serde_json::{json, Value};
use std::path::Path;

#[cfg(target_os = "macos")]
pub mod macos_backend;
#[cfg(target_os = "macos")]
pub mod macos_overlay;
pub mod macos_snapshot;
#[cfg(windows)]
pub mod windows_backend;
#[cfg(windows)]
pub mod windows_cursor_glyph;
pub mod windows_cursor_motion;
#[cfg(windows)]
pub mod windows_overlay;

pub const PROTOCOL_VERSION: u64 = 1;
pub const COMPUTER_USE_PERMISSION_APP_NAME: &str = "Lume Computer Use";
pub const COMPUTER_USE_PERMISSION_APP_BUNDLE_NAME: &str = "Lume Computer Use.app";
pub const COMPUTER_USE_PERMISSION_BUNDLE_ID: &str = "com.lume.computer-use";
pub const COMPUTER_USE_DEVELOPMENT_PERMISSION_APP_NAME: &str = "Lume Computer Use (Dev)";
pub const COMPUTER_USE_DEVELOPMENT_PERMISSION_APP_BUNDLE_NAME: &str = "Lume Computer Use (Dev).app";
pub const COMPUTER_USE_DEVELOPMENT_PERMISSION_BUNDLE_ID: &str = "com.lume.computer-use.dev";
pub const COMPUTER_USE_PERMISSION_AUTHORIZATION_SUBJECT: &str = "appBundle";
pub const COMPUTER_USE_PERMISSION_GUIDE_BINARY_NAME: &str = "LumeComputerUsePermissionGuide";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesktopPermissionClientRecord {
    pub identifier: String,
    pub client_type: i32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesktopPermissionGuideLaunch {
    pub executable_path: String,
    pub args: Vec<String>,
}

#[cfg(windows)]
pub fn initialize_windows_runtime() -> windows::core::Result<()> {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };

    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
}

pub trait DesktopBackend: Send + Sync {
    fn invoke(&self, method: &str, params: &Value) -> Result<Value>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DesktopMouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DesktopClickOptions {
    pub count: u32,
    pub button: DesktopMouseButton,
}

pub(crate) fn desktop_click_options(
    params: &Value,
    force_secondary: bool,
) -> std::result::Result<DesktopClickOptions, &'static str> {
    if force_secondary {
        return Ok(DesktopClickOptions {
            count: 1,
            button: DesktopMouseButton::Right,
        });
    }

    let count = match params.get("clickCount") {
        None => 1,
        Some(value) => value
            .as_u64()
            .and_then(|count| u32::try_from(count).ok())
            .filter(|count| *count > 0)
            .ok_or("clickCount must be a positive integer")?,
    };
    let button = match params
        .get("mouseButton")
        .and_then(Value::as_str)
        .unwrap_or("left")
    {
        "left" => DesktopMouseButton::Left,
        "right" => DesktopMouseButton::Right,
        "middle" => DesktopMouseButton::Middle,
        _ => return Err("mouseButton must be left, right, or middle"),
    };
    Ok(DesktopClickOptions { count, button })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DesktopScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DesktopScrollOptions {
    pub direction: DesktopScrollDirection,
    pub pages: f64,
}

pub(crate) fn desktop_scroll_options(
    params: &Value,
) -> std::result::Result<DesktopScrollOptions, &'static str> {
    let direction = match params
        .get("direction")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("up") => DesktopScrollDirection::Up,
        Some("down") => DesktopScrollDirection::Down,
        Some("left") => DesktopScrollDirection::Left,
        Some("right") => DesktopScrollDirection::Right,
        _ => return Err("direction must be up, down, left, or right"),
    };
    let pages = params.get("pages").map_or(Some(1.0), Value::as_f64);
    let Some(pages) = pages.filter(|pages| pages.is_finite() && *pages > 0.0) else {
        return Err("pages must be > 0");
    };
    Ok(DesktopScrollOptions { direction, pages })
}

pub(crate) fn desktop_drag_points(from: (i64, i64), to: (i64, i64), steps: u32) -> Vec<(i64, i64)> {
    let steps = steps.max(1);
    (1..=steps)
        .map(|step| {
            let progress = f64::from(step) / f64::from(steps);
            (
                (from.0 as f64 + ((to.0 - from.0) as f64 * progress)).round() as i64,
                (from.1 as f64 + ((to.1 - from.1) as f64 * progress)).round() as i64,
            )
        })
        .collect()
}

impl<T: DesktopBackend + ?Sized> DesktopBackend for Box<T> {
    fn invoke(&self, method: &str, params: &Value) -> Result<Value> {
        (**self).invoke(method, params)
    }
}

pub struct DesktopSession<B> {
    expected_token: String,
    authenticated: bool,
    backend: B,
}

impl<B: DesktopBackend> DesktopSession<B> {
    pub fn new(expected_token: impl Into<String>, backend: B) -> Self {
        Self {
            expected_token: expected_token.into(),
            authenticated: false,
            backend,
        }
    }

    pub fn handle(&mut self, request: Value) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            return rpc_error(id, -32600, "invalid request");
        };
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

        if method == "system.handshake" {
            let token = params
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if token != self.expected_token {
                return rpc_error(id, -32001, "desktop host authentication failed");
            }
            self.authenticated = true;
            return rpc_result(
                id,
                json!({ "status": "ok", "protocolVersion": PROTOCOL_VERSION }),
            );
        }

        if !self.authenticated {
            return rpc_error(id, -32001, "desktop host authentication required");
        }

        match self.backend.invoke(method, &params) {
            Ok(result) => rpc_result(id, result),
            Err(error) => rpc_error(id, -32000, &format!("{error:#}")),
        }
    }
}

pub struct UnsupportedBackend;

impl DesktopBackend for UnsupportedBackend {
    fn invoke(&self, method: &str, _params: &Value) -> Result<Value> {
        if method == "diagnose_permissions" || method == "request_permissions" {
            return Ok(desktop_permission_diagnostics(
                None,
                None,
                Some(format!(
                    "macOS permission diagnostics are unavailable on {}",
                    std::env::consts::OS
                )),
            ));
        }
        Ok(json!({
            "status": "unavailable",
            "message": format!("desktop method is unavailable on this platform: {method}")
        }))
    }
}

pub fn desktop_permission_diagnostics(
    accessibility: Option<bool>,
    screen_recording: Option<bool>,
    message: Option<String>,
) -> Value {
    let status = match (accessibility, screen_recording) {
        (Some(true), Some(true)) => "ok",
        (Some(_), Some(_)) => "permission_denied",
        _ => "unavailable",
    };
    let permissions = vec![
        permission_diagnostic(
            "accessibility",
            "Accessibility",
            accessibility,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ),
        permission_diagnostic(
            "screenRecording",
            "Screen & System Audio Recording",
            screen_recording,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        ),
    ];
    let missing_permissions = permissions
        .iter()
        .filter(|permission| permission["status"] == "missing")
        .cloned()
        .collect::<Vec<_>>();
    let next_permission = missing_permissions.first().cloned();
    let mut result = json!({
        "status": status,
        "platform": std::env::consts::OS,
        "permissionTarget": current_desktop_permission_target(),
        "permissions": permissions,
        "missingPermissions": missing_permissions,
    });
    if let Some(next_permission) = next_permission {
        result["nextPermission"] = next_permission;
    }
    if let Some(message) = message {
        result["message"] = Value::String(message);
    }
    result
}

pub fn current_computer_use_permission_app_bundle_name() -> String {
    current_desktop_permission_target()["appBundleName"]
        .as_str()
        .unwrap_or(COMPUTER_USE_PERMISSION_APP_BUNDLE_NAME)
        .to_owned()
}

pub fn current_computer_use_permission_app_bundle_path() -> Option<String> {
    current_app_bundle_path().filter(|path| {
        !desktop_permission_clients_for_app_bundle_path(Some(path.as_str())).is_empty()
    })
}

#[cfg(target_os = "macos")]
pub fn current_computer_use_permission_clients() -> Vec<DesktopPermissionClientRecord> {
    desktop_permission_clients_for_app_bundle_path(current_app_bundle_path().as_deref())
}

pub fn desktop_permission_clients_for_app_bundle_path(
    app_bundle_path: Option<&str>,
) -> Vec<DesktopPermissionClientRecord> {
    let Some(app_bundle_path) = app_bundle_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return Vec::new();
    };
    let app_bundle_name = Path::new(app_bundle_path)
        .file_name()
        .and_then(|value| value.to_str());
    if !matches!(
        app_bundle_name,
        Some(COMPUTER_USE_PERMISSION_APP_BUNDLE_NAME)
            | Some(COMPUTER_USE_DEVELOPMENT_PERMISSION_APP_BUNDLE_NAME)
    ) {
        return Vec::new();
    }

    let target = desktop_permission_target_for_app_bundle_path(Some(app_bundle_path));
    let mut clients = Vec::new();
    if let Some(bundle_id) = target["bundleId"].as_str() {
        push_unique_permission_client(
            &mut clients,
            DesktopPermissionClientRecord {
                identifier: bundle_id.to_owned(),
                client_type: 0,
            },
        );
    }
    push_unique_permission_client(
        &mut clients,
        DesktopPermissionClientRecord {
            identifier: app_bundle_path.to_owned(),
            client_type: 1,
        },
    );
    clients
}

pub fn desktop_permission_guide_launch_for_app_bundle_path(
    app_bundle_path: Option<&str>,
    permission_id: &str,
    settings_url: &str,
) -> Option<DesktopPermissionGuideLaunch> {
    let app_bundle_path = app_bundle_path
        .map(str::trim)
        .filter(|path| !path.is_empty())?
        .trim_end_matches(['/', '\\']);
    if desktop_permission_clients_for_app_bundle_path(Some(app_bundle_path)).is_empty() {
        return None;
    }
    let target = desktop_permission_target_for_app_bundle_path(Some(app_bundle_path));
    let app_name = target["appBundleName"]
        .as_str()
        .unwrap_or(COMPUTER_USE_PERMISSION_APP_BUNDLE_NAME);

    Some(DesktopPermissionGuideLaunch {
        executable_path: format!(
            "{app_bundle_path}/Contents/MacOS/{COMPUTER_USE_PERMISSION_GUIDE_BINARY_NAME}"
        ),
        args: vec![
            "--app-bundle".to_owned(),
            app_bundle_path.to_owned(),
            "--app-name".to_owned(),
            app_name.to_owned(),
            "--permission".to_owned(),
            permission_id.to_owned(),
            "--settings-url".to_owned(),
            settings_url.to_owned(),
        ],
    })
}

pub fn desktop_permission_granted(persisted: Option<bool>, runtime: bool) -> bool {
    persisted == Some(true) || runtime
}

fn current_desktop_permission_target() -> Value {
    desktop_permission_target_for_app_bundle_name(current_app_bundle_name().as_deref())
}

fn desktop_permission_target_for_app_bundle_path(app_bundle_path: Option<&str>) -> Value {
    let app_bundle_name = app_bundle_path
        .and_then(|path| Path::new(path).file_name())
        .and_then(|value| value.to_str());
    desktop_permission_target_for_app_bundle_name(app_bundle_name)
}

pub fn desktop_permission_target_for_app_bundle_name(app_bundle_name: Option<&str>) -> Value {
    let is_development =
        app_bundle_name == Some(COMPUTER_USE_DEVELOPMENT_PERMISSION_APP_BUNDLE_NAME);
    let (app_name, app_bundle_name, bundle_id) = if is_development {
        (
            COMPUTER_USE_DEVELOPMENT_PERMISSION_APP_NAME,
            COMPUTER_USE_DEVELOPMENT_PERMISSION_APP_BUNDLE_NAME,
            COMPUTER_USE_DEVELOPMENT_PERMISSION_BUNDLE_ID,
        )
    } else {
        (
            COMPUTER_USE_PERMISSION_APP_NAME,
            COMPUTER_USE_PERMISSION_APP_BUNDLE_NAME,
            COMPUTER_USE_PERMISSION_BUNDLE_ID,
        )
    };

    json!({
        "appName": app_name,
        "appBundleName": app_bundle_name,
        "bundleId": bundle_id,
        "authorizationSubject": COMPUTER_USE_PERMISSION_AUTHORIZATION_SUBJECT,
    })
}

fn current_app_bundle_name() -> Option<String> {
    current_app_bundle_path()
        .as_deref()
        .and_then(|path| Path::new(path).file_name())
        .and_then(|value| value.to_str())
        .map(str::to_owned)
}

fn current_app_bundle_path() -> Option<String> {
    let executable = std::env::current_exe().ok()?;
    executable
        .ancestors()
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .map(|path| path.to_string_lossy().into_owned())
}

fn push_unique_permission_client(
    clients: &mut Vec<DesktopPermissionClientRecord>,
    record: DesktopPermissionClientRecord,
) {
    if !clients.iter().any(|client| client == &record) {
        clients.push(record);
    }
}

fn permission_diagnostic(
    id: &str,
    title: &str,
    granted: Option<bool>,
    settings_url: &str,
) -> Value {
    let app_name = current_computer_use_permission_app_bundle_name();
    json!({
        "id": id,
        "title": title,
        "status": match granted {
            Some(true) => "granted",
            Some(false) => "missing",
            None => "unknown",
        },
        "settingsUrl": settings_url,
        "instruction": permission_instruction(id, title, &app_name),
    })
}

fn permission_instruction(id: &str, title: &str, app_name: &str) -> String {
    match id {
        "accessibility" => {
            format!("在 macOS 系统设置的 {title} 中添加并开启 {app_name}，不要授权 Lume 主应用。")
        }
        _ => format!("在 macOS 系统设置的 {title} 中开启 {app_name}，不要授权 Lume 主应用。"),
    }
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod click_options_tests {
    use super::*;

    #[test]
    fn parses_codex_aligned_click_count_and_mouse_button() {
        assert_eq!(
            desktop_click_options(&json!({}), false),
            Ok(DesktopClickOptions {
                count: 1,
                button: DesktopMouseButton::Left,
            })
        );
        assert_eq!(
            desktop_click_options(&json!({ "clickCount": 2, "mouseButton": "middle" }), false,),
            Ok(DesktopClickOptions {
                count: 2,
                button: DesktopMouseButton::Middle,
            })
        );
        assert_eq!(
            desktop_click_options(&json!({ "clickCount": 4 }), false),
            Ok(DesktopClickOptions {
                count: 4,
                button: DesktopMouseButton::Left,
            })
        );
        assert_eq!(
            desktop_click_options(&json!({ "clickCount": 3, "mouseButton": "left" }), true,),
            Ok(DesktopClickOptions {
                count: 1,
                button: DesktopMouseButton::Right,
            })
        );
    }

    #[test]
    fn rejects_unsupported_click_counts_and_mouse_buttons() {
        assert_eq!(
            desktop_click_options(&json!({ "clickCount": 0 }), false),
            Err("clickCount must be a positive integer")
        );
        assert_eq!(
            desktop_click_options(&json!({ "clickCount": 1.5 }), false),
            Err("clickCount must be a positive integer")
        );
        assert_eq!(
            desktop_click_options(&json!({ "mouseButton": "back" }), false),
            Err("mouseButton must be left, right, or middle")
        );
    }
}

#[cfg(test)]
mod scroll_options_tests {
    use super::*;

    #[test]
    fn parses_direction_and_fractional_pages() {
        assert_eq!(
            desktop_scroll_options(&json!({ "direction": "down" })),
            Ok(DesktopScrollOptions {
                direction: DesktopScrollDirection::Down,
                pages: 1.0,
            })
        );
        assert_eq!(
            desktop_scroll_options(&json!({ "direction": " LEFT ", "pages": 0.5 })),
            Ok(DesktopScrollOptions {
                direction: DesktopScrollDirection::Left,
                pages: 0.5,
            })
        );
    }

    #[test]
    fn rejects_missing_or_invalid_scroll_options() {
        assert_eq!(
            desktop_scroll_options(&json!({})),
            Err("direction must be up, down, left, or right")
        );
        assert_eq!(
            desktop_scroll_options(&json!({ "direction": "forward" })),
            Err("direction must be up, down, left, or right")
        );
        assert_eq!(
            desktop_scroll_options(&json!({ "direction": "up", "pages": 0 })),
            Err("pages must be > 0")
        );
        assert_eq!(
            desktop_scroll_options(&json!({ "direction": "up", "pages": -1 })),
            Err("pages must be > 0")
        );
    }
}

#[cfg(test)]
mod drag_points_tests {
    use super::*;

    #[test]
    fn interpolates_drag_points_through_the_exact_endpoint() {
        let points = desktop_drag_points((0, 0), (100, 50), 10);

        assert_eq!(points.len(), 10);
        assert_eq!(points[0], (10, 5));
        assert_eq!(points[5], (60, 30));
        assert_eq!(points[9], (100, 50));
    }

    #[test]
    fn preserves_negative_desktop_coordinates() {
        let points = desktop_drag_points((-100, 50), (20, -10), 12);

        assert_eq!(points[0], (-90, 45));
        assert_eq!(points[11], (20, -10));
    }
}
