#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use base64::Engine as _;
use tauri::Emitter;
use tauri::Manager;

struct SidecarProcess(Mutex<Option<Child>>);
static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
fn healthcheck() -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "source": "desktop"
    })
}

#[tauri::command]
fn sidecar_healthcheck(
    state: tauri::State<SidecarProcess>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    sidecar_call_internal(&state, "healthcheck", serde_json::Value::Null, &app)
}

#[tauri::command]
fn sidecar_call(
    method: String,
    params: Option<serde_json::Value>,
    state: tauri::State<SidecarProcess>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    sidecar_call_internal(&state, &method, params.unwrap_or(serde_json::Value::Null), &app)
}

#[tauri::command]
fn open_file_dialog() -> Result<serde_json::Value, String> {
    let files = rfd::FileDialog::new()
        .add_filter(
            "Supported Files",
            &[
                "png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "json", "csv", "xml",
                "html", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "odp", "ods",
            ],
        )
        .pick_files()
        .unwrap_or_default();

    let mut out = Vec::<serde_json::Value>::new();
    for file_path in files {
        let bytes = std::fs::read(&file_path)
            .map_err(|e| format!("read selected file failed ({}): {e}", file_path.display()))?;
        let filename = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let media_type = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "pdf" => "application/pdf",
            "txt" => "text/plain",
            "md" => "text/markdown",
            "json" => "application/json",
            "csv" => "text/csv",
            "xml" => "application/xml",
            "html" => "text/html",
            "doc" => "application/msword",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls" => "application/vnd.ms-excel",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt" => "application/vnd.ms-powerpoint",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "odt" => "application/vnd.oasis.opendocument.text",
            "odp" => "application/vnd.oasis.opendocument.presentation",
            "ods" => "application/vnd.oasis.opendocument.spreadsheet",
            _ => "application/octet-stream",
        };
        let size = bytes.len();
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        out.push(serde_json::json!({
            "filename": filename,
            "mediaType": media_type,
            "data": data,
            "size": size
        }));
    }

    Ok(serde_json::json!({ "files": out }))
}

#[tauri::command]
fn open_folder_dialog() -> Result<serde_json::Value, String> {
    let picked = rfd::FileDialog::new().pick_folder();
    let path = picked
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    Ok(serde_json::json!({ "path": path }))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http/https urls are allowed".to_string());
    }
    webbrowser::open(&url).map_err(|e| format!("open external url failed: {e}"))?;
    Ok(())
}

fn sidecar_call_internal(
    state: &tauri::State<SidecarProcess>,
    method: &str,
    params: serde_json::Value,
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let request_id = NEXT_RPC_ID.fetch_add(1, Ordering::Relaxed);
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "sidecar lock poisoned".to_string())?;
    let child = guard
        .as_mut()
        .ok_or_else(|| "sidecar is not running".to_string())?;

    let request = serde_json::json!({
        "id": request_id,
        "method": method,
        "params": params
    });

    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "sidecar stdin unavailable".to_string())?;
    writeln!(stdin, "{}", request).map_err(|error| format!("write sidecar request failed: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("flush sidecar request failed: {error}"))?;

    loop {
        let stdout = child
            .stdout
            .as_mut()
            .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
        let line = read_line(stdout)?;
        let parsed = match serde_json::from_str::<serde_json::Value>(line.trim()) {
            Ok(value) => value,
            Err(_) => continue,
        };

        // Notification from sidecar: forward to web via Tauri event.
        if parsed.get("id").is_none() {
            if let Some(method) = parsed.get("method").and_then(serde_json::Value::as_str) {
                let payload = serde_json::json!({
                    "method": method,
                    "params": parsed.get("params").cloned().unwrap_or(serde_json::Value::Null),
                });
                let _ = app.emit("sidecar:event", payload);
            }
            continue;
        }

        let response_id = parsed.get("id").and_then(serde_json::Value::as_u64);
        if response_id != Some(request_id) {
            continue;
        }

        if let Some(error) = parsed.get("error") {
            let message = error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown sidecar error");
            return Err(message.to_string());
        }

        return Ok(parsed.get("result").cloned().unwrap_or(serde_json::Value::Null));
    }
}

fn read_line(stdout: &mut ChildStdout) -> Result<String, String> {
    let mut bytes = Vec::<u8>::new();
    let mut one = [0u8; 1];

    loop {
        match stdout.read(&mut one) {
            Ok(0) => return Err("sidecar closed stdout".to_string()),
            Ok(_) => {
                if one[0] == b'\n' {
                    break;
                }
                bytes.push(one[0]);
            }
            Err(error) => return Err(format!("read sidecar response failed: {error}")),
        }
    }

    String::from_utf8(bytes).map_err(|error| format!("invalid utf8 from sidecar: {error}"))
}

fn spawn_sidecar_from_env() -> Option<Child> {
    let cmd = std::env::var("LUME_SIDECAR_CMD").ok()?;
    if cmd.trim().is_empty() {
        return None;
    }

    let mut process = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/C", &cmd]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-lc", &cmd]);
        c
    };

    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    match process.spawn() {
        Ok(child) => {
            println!("[desktop] sidecar process booted from LUME_SIDECAR_CMD");
            Some(child)
        }
        Err(error) => {
            eprintln!("[desktop] failed to spawn sidecar: {error}");
            None
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(SidecarProcess(Mutex::new(None)))
        .setup(|app| {
            let state = app.state::<SidecarProcess>();
            if let Some(child) = spawn_sidecar_from_env() {
                if let Ok(mut slot) = state.0.lock() {
                    *slot = Some(child);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            sidecar_healthcheck,
            sidecar_call,
            open_file_dialog,
            open_folder_dialog,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarProcess>() {
                    if let Ok(mut slot) = state.0.lock() {
                        if let Some(child) = slot.as_mut() {
                            let _ = child.kill();
                            println!("[desktop] sidecar process terminated");
                        }
                        *slot = None;
                    }
                }
            }
        });
}
