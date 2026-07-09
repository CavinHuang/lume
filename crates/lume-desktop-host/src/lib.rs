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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesktopPermissionClientRecord {
    pub identifier: String,
    pub client_type: i32,
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
    json!({
        "id": id,
        "title": title,
        "status": match granted {
            Some(true) => "granted",
            Some(false) => "missing",
            None => "unknown",
        },
        "settingsUrl": settings_url,
    })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message } })
}
