#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use log::{error, info, warn};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

type PendingResponseMap = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<serde_json::Value, String>>>>>;
const SIDECAR_RESPONSE_TIMEOUT_SECS: u64 = 45;

struct SidecarProcess {
    child: Mutex<Option<Child>>,
    pending: PendingResponseMap,
}

impl SidecarProcess {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);
static LOGGED_ENV_CMD_IGNORED: AtomicBool = AtomicBool::new(false);

fn env_flag_enabled(key: &str) -> bool {
    std::env::var(key)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn has_env_sidecar_cmd() -> bool {
    std::env::var("LUME_SIDECAR_CMD")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn spawn_sidecar_with_strategy(app: &tauri::AppHandle) -> Option<Child> {
    let prefer_env = env_flag_enabled("LUME_SIDECAR_PREFER_ENV");
    if prefer_env {
        return spawn_sidecar_from_env().or_else(|| spawn_sidecar_default(app));
    }

    if has_env_sidecar_cmd()
        && !LOGGED_ENV_CMD_IGNORED.swap(true, Ordering::Relaxed)
    {
        warn!(
            "[desktop] LUME_SIDECAR_CMD detected but ignored by default; set LUME_SIDECAR_PREFER_ENV=1 to prefer env sidecar command"
        );
    }

    spawn_sidecar_default(app).or_else(|| spawn_sidecar_from_env())
}

fn is_broken_pipe_error_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("broken pipe") || lower.contains("os error 32")
}

fn spawn_managed_sidecar(
    state: &tauri::State<'_, SidecarProcess>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let mut child = spawn_sidecar_with_strategy(app)
        .ok_or_else(|| "sidecar spawn failed".to_string())?;

    if let Some(stdout) = child.stdout.take() {
        spawn_sidecar_stdout_reader(stdout, Arc::clone(&state.pending), app.clone());
    } else {
        warn!("[desktop] sidecar stdout unavailable after spawn");
    }

    let mut slot = state
        .child
        .lock()
        .map_err(|_| "sidecar lock poisoned".to_string())?;
    *slot = Some(child);
    Ok(())
}

fn ensure_sidecar_running(
    state: &tauri::State<'_, SidecarProcess>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let mut should_respawn = false;
    {
        let mut slot = state
            .child
            .lock()
            .map_err(|_| "sidecar lock poisoned".to_string())?;
        match slot.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    warn!("[desktop] sidecar exited before request: {status}");
                    *slot = None;
                    should_respawn = true;
                }
                Ok(None) => {}
                Err(error) => {
                    warn!("[desktop] sidecar try_wait failed: {error}");
                    *slot = None;
                    should_respawn = true;
                }
            },
            None => {
                should_respawn = true;
            }
        }
    }

    if should_respawn {
        info!("[desktop] respawning sidecar");
        spawn_managed_sidecar(state, app)?;
    }

    Ok(())
}

#[tauri::command]
fn healthcheck() -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "source": "desktop"
    })
}

#[tauri::command]
async fn sidecar_healthcheck(
    state: tauri::State<'_, SidecarProcess>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    sidecar_call_internal(&state, "healthcheck", serde_json::Value::Null, &app).await
}

#[tauri::command]
async fn sidecar_call(
    method: String,
    params: Option<serde_json::Value>,
    state: tauri::State<'_, SidecarProcess>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    sidecar_call_internal(
        &state,
        &method,
        params.unwrap_or(serde_json::Value::Null),
        &app,
    )
    .await
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
        let size = std::fs::metadata(&file_path)
            .map_err(|e| format!("stat selected file failed ({}): {e}", file_path.display()))?
            .len() as usize;
        out.push(serde_json::json!({
            "filename": filename,
            "mediaType": media_type,
            "size": size,
            "sourcePath": file_path.to_string_lossy().to_string()
        }));
    }

    Ok(serde_json::json!({ "files": out }))
}

#[tauri::command]
fn open_folder_dialog() -> Result<serde_json::Value, String> {
    let picked = rfd::FileDialog::new().pick_folder();
    let path = picked.as_ref().map(|p| p.to_string_lossy().to_string());
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

async fn sidecar_call_internal(
    state: &tauri::State<'_, SidecarProcess>,
    method: &str,
    params: serde_json::Value,
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    ensure_sidecar_running(state, app)?;
    info!("[desktop] sidecar_call: {method}");
    let request_id = NEXT_RPC_ID.fetch_add(1, Ordering::Relaxed);

    let (tx, rx) = mpsc::channel::<Result<serde_json::Value, String>>();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "sidecar pending map lock poisoned".to_string())?;
        pending.insert(request_id, tx);
    }

    let request = serde_json::json!({
        "id": request_id,
        "method": method,
        "params": params
    });
    let request_line = format!("{request}\n");

    {
        let mut guard = state
            .child
            .lock()
            .map_err(|_| "sidecar lock poisoned".to_string())?;
        let child = guard
            .as_mut()
            .ok_or_else(|| "sidecar is not running".to_string())?;
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "sidecar stdin unavailable".to_string())?;

        if let Err(error) = stdin.write_all(request_line.as_bytes()) {
            remove_pending_request(state, request_id);
            if is_broken_pipe_error_message(&error.to_string()) {
                if let Ok(mut slot) = state.child.lock() {
                    *slot = None;
                }
            }
            return Err(format!("write sidecar request failed: {error}"));
        }

        if let Err(error) = stdin.flush() {
            remove_pending_request(state, request_id);
            if is_broken_pipe_error_message(&error.to_string()) {
                if let Ok(mut slot) = state.child.lock() {
                    *slot = None;
                }
            }
            return Err(format!("flush sidecar request failed: {error}"));
        }
    }
    info!("[desktop] sidecar_write_ok: id={request_id} method={method}");

    let recv_result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(SIDECAR_RESPONSE_TIMEOUT_SECS))
    })
    .await
    .map_err(|error| format!("sidecar wait task join failed: {error}"))?;

    match recv_result {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            remove_pending_request(state, request_id);
            Err(format!("sidecar response timeout for method: {method}"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("sidecar response channel disconnected".to_string())
        }
    }
}

fn remove_pending_request(state: &tauri::State<'_, SidecarProcess>, request_id: u64) {
    if let Ok(mut waiters) = state.pending.lock() {
        waiters.remove(&request_id);
    }
}

fn spawn_sidecar_stdout_reader(
    stdout: ChildStdout,
    pending: PendingResponseMap,
    app: tauri::AppHandle,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut close_reason = "sidecar closed stdout".to_string();

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) => {
                    close_reason = format!("read sidecar response failed: {error}");
                    break;
                }
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let parsed = match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(value) => value,
                Err(_) => continue,
            };

            if let Some(response_id) = parsed.get("id").and_then(serde_json::Value::as_u64) {
                info!("[desktop] sidecar_response: id={response_id}");
                let sender = pending
                    .lock()
                    .ok()
                    .and_then(|mut waiters| waiters.remove(&response_id));
                if let Some(tx) = sender {
                    if let Some(error) = parsed.get("error") {
                        let message = error
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown sidecar error");
                        let _ = tx.send(Err(message.to_string()));
                    } else {
                        let result = parsed
                            .get("result")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let _ = tx.send(Ok(result));
                    }
                }
                continue;
            }

            if let Some(method) = parsed.get("method").and_then(serde_json::Value::as_str) {
                info!("[desktop] sidecar_event: {method}");
                let payload = serde_json::json!({
                    "method": method,
                    "params": parsed.get("params").cloned().unwrap_or(serde_json::Value::Null),
                });
                let _ = app.emit("sidecar:event", payload);
            }
        }

        if let Ok(mut waiters) = pending.lock() {
            for (_, tx) in waiters.drain() {
                let _ = tx.send(Err(close_reason.clone()));
            }
        }
    });
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
        .stderr(Stdio::inherit());

    match process.spawn() {
        Ok(child) => {
            info!("[desktop] sidecar process booted from LUME_SIDECAR_CMD");
            Some(child)
        }
        Err(error) => {
            error!("[desktop] failed to spawn sidecar: {error}");
            None
        }
    }
}

fn resolve_bun_binary() -> String {
    if let Ok(home) = std::env::var("HOME") {
        let volta_bun = PathBuf::from(home).join(".volta/tools/image/packages/bun/bin/bun");
        if volta_bun.exists() {
            return volta_bun.to_string_lossy().to_string();
        }
    }
    "bun".to_string()
}

fn resolve_default_skills_dir(app: &tauri::AppHandle, sidecar_dir: &PathBuf) -> Option<String> {
    if let Ok(configured) = std::env::var("LUME_DEFAULT_SKILLS_DIR") {
        if !configured.trim().is_empty() && PathBuf::from(&configured).exists() {
            return Some(configured);
        }
    }

    let dev_dir = sidecar_dir.join("default-skills");
    if dev_dir.exists() {
        return Some(dev_dir.to_string_lossy().to_string());
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged_dir = resource_dir.join("default-skills");
        if packaged_dir.exists() {
            return Some(packaged_dir.to_string_lossy().to_string());
        }
    }

    None
}

fn spawn_sidecar_default(app: &tauri::AppHandle) -> Option<Child> {
    let sidecar_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar");
    if !sidecar_dir.exists() {
        warn!(
            "[desktop] default sidecar dir not found: {}",
            sidecar_dir.display()
        );
        return None;
    }

    let bun_bin = resolve_bun_binary();
    let dist_entry = sidecar_dir.join("dist/index.js");
    let src_entry = sidecar_dir.join("src/index.ts");
    let sidecar_entry = if cfg!(debug_assertions) {
        src_entry.clone()
    } else if dist_entry.exists() {
        dist_entry
    } else {
        src_entry
    };
    let mut process = Command::new(&bun_bin);
    let default_skills_dir = resolve_default_skills_dir(app, &sidecar_dir);
    process
        .arg(sidecar_entry.to_string_lossy().to_string())
        .current_dir(&sidecar_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(skills_dir) = default_skills_dir.as_ref() {
        process.env("LUME_DEFAULT_SKILLS_DIR", skills_dir);
    }

    match process.spawn() {
        Ok(child) => {
            info!(
                "[desktop] sidecar process booted from default path: {} (runtime=bun-direct, entry={}, bun={}, default-skills={})",
                sidecar_dir.display(),
                sidecar_entry.display(),
                bun_bin,
                default_skills_dir.as_deref().unwrap_or("not-found")
            );
            Some(child)
        }
        Err(error) => {
            error!("[desktop] failed to spawn default sidecar: {error}");
            None
        }
    }
}

fn get_logs_dir() -> PathBuf {
    // 统一使用 ~/.lume/logs 目录
    if let Some(home) = dirs::home_dir() {
        let logs_dir = home.join(".lume").join("logs");
        if !logs_dir.exists() {
            let _ = std::fs::create_dir_all(&logs_dir);
        }
        return logs_dir;
    }
    PathBuf::from(".")
}

fn main() {
    // 获取日志目录
    let logs_dir = get_logs_dir();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stderr),  // 控制台输出
                    Target::new(TargetKind::Folder { path: logs_dir.clone(), file_name: Some("desktop.log".into()) }),  // 文件输出
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(SidecarProcess::new())
        .setup(|app| {
            let state = app.state::<SidecarProcess>();
            let mut child = match spawn_sidecar_with_strategy(&app.handle()) {
                Some(child) => child,
                None => return Ok(()),
            };

            if let Some(stdout) = child.stdout.take() {
                spawn_sidecar_stdout_reader(
                    stdout,
                    Arc::clone(&state.pending),
                    app.handle().clone(),
                );
            } else {
                error!("[desktop] sidecar stdout unavailable after spawn");
            }

            if let Ok(mut slot) = state.child.lock() {
                *slot = Some(child);
            }

            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
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
                    if let Ok(mut slot) = state.child.lock() {
                        if let Some(child) = slot.as_mut() {
                            let _ = child.kill();
                            info!("[desktop] sidecar process terminated");
                        }
                        *slot = None;
                    }
                }
            }
        });
}
