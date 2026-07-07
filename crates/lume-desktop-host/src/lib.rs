use anyhow::Result;
use serde_json::{json, Value};

#[cfg(windows)]
pub mod windows_backend;
#[cfg(windows)]
pub mod windows_cursor_glyph;
#[cfg(windows)]
pub mod windows_cursor_motion;
#[cfg(windows)]
pub mod windows_overlay;

pub const PROTOCOL_VERSION: u64 = 1;

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
        Ok(json!({
            "status": "unavailable",
            "message": format!("desktop method is unavailable on this platform: {method}")
        }))
    }
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message } })
}
