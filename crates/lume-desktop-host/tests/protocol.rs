use lume_desktop_host::{DesktopBackend, DesktopSession, UnsupportedBackend};
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
    assert_eq!(response["result"]["permissions"][0]["id"], "accessibility");
    assert_eq!(
        response["result"]["permissions"][1]["id"],
        "screenRecording"
    );
    assert_eq!(
        response["result"]["permissions"][0]["settingsUrl"],
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
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
}
