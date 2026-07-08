use crate::{desktop_permission_diagnostics, DesktopBackend};
use anyhow::Result;
use serde_json::{json, Value};
use std::os::raw::c_uchar;

pub struct MacOSDesktopBackend;

impl DesktopBackend for MacOSDesktopBackend {
    fn invoke(&self, method: &str, _params: &Value) -> Result<Value> {
        let permissions = permission_state();
        if method == "diagnose_permissions" {
            return Ok(desktop_permission_diagnostics(
                Some(permissions.accessibility),
                Some(permissions.screen_recording),
                None,
            ));
        }
        if !permissions.all_granted() {
            return Ok(desktop_permission_diagnostics(
                Some(permissions.accessibility),
                Some(permissions.screen_recording),
                Some("macOS desktop control requires Accessibility and Screen Recording permissions for Lume Computer Use.app".to_owned()),
            ));
        }
        Ok(json!({
            "status": "unavailable",
            "message": format!("desktop method is not implemented on macOS yet: {method}")
        }))
    }
}

struct MacOSPermissionState {
    accessibility: bool,
    screen_recording: bool,
}

impl MacOSPermissionState {
    fn all_granted(&self) -> bool {
        self.accessibility && self.screen_recording
    }
}

fn permission_state() -> MacOSPermissionState {
    MacOSPermissionState {
        accessibility: ax_is_process_trusted(),
        screen_recording: cg_preflight_screen_capture_access(),
    }
}

fn ax_is_process_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

fn cg_preflight_screen_capture_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> c_uchar;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}
