use lume_desktop_host::{
    desktop_permission_clients_for_app_bundle_path, desktop_permission_diagnostics,
    desktop_permission_granted, desktop_permission_guide_launch_for_app_bundle_path,
    desktop_permission_target_for_app_bundle_name, DesktopBackend, DesktopSession,
    UnsupportedBackend,
};
use serde_json::{json, Value};

struct FakeBackend;

impl DesktopBackend for FakeBackend {
    fn invoke(&self, method: &str, _params: &Value) -> anyhow::Result<Value> {
        match method {
            "list_apps" => Ok(json!({ "status": "ok", "apps": [] })),
            _ => Ok(
                json!({ "status": "failed", "message": format!("unsupported method: {method}") }),
            ),
        }
    }
}

#[test]
fn requires_a_valid_handshake_before_desktop_calls() {
    let mut session = DesktopSession::new("expected-token", FakeBackend);
    let unauthorized = session.handle(json!({ "id": 1, "method": "list_apps", "params": {} }));
    assert_eq!(unauthorized["id"], 1);
    assert_eq!(unauthorized["error"]["code"], -32001);

    let rejected = session.handle(json!({
        "id": 2,
        "method": "system.handshake",
        "params": { "token": "wrong-token" }
    }));
    assert_eq!(rejected["error"]["code"], -32001);

    let accepted = session.handle(json!({
        "id": 3,
        "method": "system.handshake",
        "params": { "token": "expected-token" }
    }));
    assert_eq!(
        accepted["result"],
        json!({ "status": "ok", "protocolVersion": 1 })
    );

    let result = session.handle(json!({ "id": 4, "method": "list_apps", "params": {} }));
    assert_eq!(result["result"], json!({ "status": "ok", "apps": [] }));

    let subscription = session.handle(json!({
        "id": 5,
        "method": "system.set_event_subscription",
        "params": { "enabled": true }
    }));
    assert_eq!(
        subscription["result"],
        json!({ "status": "ok", "enabled": true })
    );
}

#[test]
fn reports_invalid_requests_and_backend_errors_as_json_rpc_errors() {
    let mut session = DesktopSession::new("token", FakeBackend);
    let invalid = session.handle(json!({ "method": 42 }));
    assert_eq!(invalid["error"]["code"], -32600);

    let _ = session.handle(json!({
        "id": 1,
        "method": "system.handshake",
        "params": { "token": "token" }
    }));
    let unsupported = session.handle(json!({ "id": 2, "method": "does_not_exist", "params": {} }));
    assert_eq!(unsupported["result"]["status"], "failed");
    assert_eq!(
        unsupported["result"]["message"],
        "unsupported method: does_not_exist"
    );
}

#[test]
fn diagnose_permissions_reports_the_computer_use_permission_identity() {
    let mut session = DesktopSession::new("token", UnsupportedBackend);
    let _ = session.handle(json!({
        "id": 1,
        "method": "system.handshake",
        "params": { "token": "token" }
    }));

    let response = session.handle(json!({
        "id": 2,
        "method": "diagnose_permissions",
        "params": {}
    }));

    assert_eq!(
        response["result"]["permissionTarget"]["appName"],
        "Lume Computer Use"
    );
    assert_eq!(
        response["result"]["permissionTarget"]["bundleId"],
        "com.lume.computer-use"
    );
    assert_eq!(
        response["result"]["permissionTarget"]["authorizationSubject"],
        "appBundle"
    );
    assert_eq!(response["result"]["permissions"][0]["id"], "accessibility");
    assert_eq!(
        response["result"]["permissions"][1]["id"],
        "screenRecording"
    );
    assert_eq!(
        response["result"]["permissions"][0]["settingsUrl"],
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    );
    assert_eq!(
        response["result"]["permissions"][0]["instruction"],
        "在 macOS 系统设置的 Accessibility 中添加并开启 Lume Computer Use.app，不要授权 Lume 主应用。"
    );
    assert_eq!(
        response["result"]["permissions"][1]["instruction"],
        "在 macOS 系统设置的 Screen & System Audio Recording 中开启 Lume Computer Use.app，不要授权 Lume 主应用。"
    );
}

#[test]
fn request_permissions_reports_the_computer_use_permission_identity() {
    let mut session = DesktopSession::new("token", UnsupportedBackend);
    let _ = session.handle(json!({
        "id": 1,
        "method": "system.handshake",
        "params": { "token": "token" }
    }));

    let response = session.handle(json!({
        "id": 2,
        "method": "request_permissions",
        "params": {}
    }));

    assert_eq!(response["result"]["status"], "unavailable");
    assert_eq!(
        response["result"]["permissionTarget"]["appName"],
        "Lume Computer Use"
    );
    assert_eq!(
        response["result"]["permissionTarget"]["appBundleName"],
        "Lume Computer Use.app"
    );
    assert_eq!(
        response["result"]["permissionTarget"]["bundleId"],
        "com.lume.computer-use"
    );
    assert_eq!(
        response["result"]["permissionTarget"]["authorizationSubject"],
        "appBundle"
    );
}

#[test]
fn permission_diagnostics_report_missing_and_next_permission() {
    let response = desktop_permission_diagnostics(Some(true), Some(false), None);

    assert_eq!(response["status"], "permission_denied");
    assert_eq!(response["missingPermissions"].as_array().unwrap().len(), 1);
    assert_eq!(response["missingPermissions"][0]["id"], "screenRecording");
    assert_eq!(response["nextPermission"]["id"], "screenRecording");
    assert_eq!(
        response["nextPermission"]["settingsUrl"],
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    );

    let granted = desktop_permission_diagnostics(Some(true), Some(true), None);
    assert_eq!(granted["status"], "ok");
    assert_eq!(granted["missingPermissions"].as_array().unwrap().len(), 0);
    assert!(granted.get("nextPermission").is_none());
}

#[test]
fn permission_target_uses_development_bundle_identity_when_running_from_dev_app() {
    let target = desktop_permission_target_for_app_bundle_name(Some("Lume Computer Use (Dev).app"));

    assert_eq!(target["appName"], "Lume Computer Use (Dev)");
    assert_eq!(target["appBundleName"], "Lume Computer Use (Dev).app");
    assert_eq!(target["bundleId"], "com.lume.computer-use.dev");
    assert_eq!(target["authorizationSubject"], "appBundle");
}

#[test]
fn permission_clients_target_release_computer_use_bundle_and_app_path() {
    let clients =
        desktop_permission_clients_for_app_bundle_path(Some("/Applications/Lume Computer Use.app"));

    assert_eq!(clients.len(), 2);
    assert_eq!(clients[0].identifier, "com.lume.computer-use");
    assert_eq!(clients[0].client_type, 0);
    assert_eq!(clients[1].identifier, "/Applications/Lume Computer Use.app");
    assert_eq!(clients[1].client_type, 1);
    assert!(!clients
        .iter()
        .any(|client| client.identifier == "com.lume.desktop"));
}

#[test]
fn permission_clients_target_development_computer_use_bundle_and_app_path() {
    let clients = desktop_permission_clients_for_app_bundle_path(Some(
        "/tmp/lume/resources/desktop-host/darwin-arm64/Lume Computer Use (Dev).app",
    ));

    assert_eq!(clients.len(), 2);
    assert_eq!(clients[0].identifier, "com.lume.computer-use.dev");
    assert_eq!(clients[0].client_type, 0);
    assert_eq!(
        clients[1].identifier,
        "/tmp/lume/resources/desktop-host/darwin-arm64/Lume Computer Use (Dev).app"
    );
    assert_eq!(clients[1].client_type, 1);
    assert!(!clients
        .iter()
        .any(|client| client.identifier == "com.lume.computer-use"));
}

#[test]
fn permission_clients_are_empty_outside_the_computer_use_app_bundle() {
    assert!(desktop_permission_clients_for_app_bundle_path(None).is_empty());
    assert!(
        desktop_permission_clients_for_app_bundle_path(Some("/Applications/Lume.app")).is_empty()
    );
    assert!(desktop_permission_clients_for_app_bundle_path(Some(
        "/Applications/Other Computer Use.app"
    ))
    .is_empty());
}

#[test]
fn permission_guide_launch_targets_the_computer_use_app_bundle() {
    let guide = desktop_permission_guide_launch_for_app_bundle_path(
        Some("/Applications/Lume Computer Use.app"),
        "accessibility",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    )
    .expect("release computer-use app should support permission guide launch");

    assert_eq!(
        guide.executable_path,
        "/Applications/Lume Computer Use.app/Contents/MacOS/LumeComputerUsePermissionGuide"
    );
    assert_eq!(
        guide.args,
        vec![
            "--app-bundle".to_owned(),
            "/Applications/Lume Computer Use.app".to_owned(),
            "--app-name".to_owned(),
            "Lume Computer Use.app".to_owned(),
            "--permission".to_owned(),
            "accessibility".to_owned(),
            "--settings-url".to_owned(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
                .to_owned(),
        ]
    );
}

#[test]
fn permission_guide_launch_rejects_the_lume_main_app_bundle() {
    assert!(desktop_permission_guide_launch_for_app_bundle_path(
        Some("/Applications/Lume.app"),
        "accessibility",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    )
    .is_none());
}

#[test]
fn permission_granted_accepts_persisted_tcc_authorization_when_runtime_is_stale() {
    assert!(desktop_permission_granted(Some(true), false));
    assert!(desktop_permission_granted(None, true));
    assert!(!desktop_permission_granted(Some(false), false));
    assert!(!desktop_permission_granted(None, false));
}
