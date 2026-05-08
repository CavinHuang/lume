#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use log::{error, info, warn};
use serde::Deserialize;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

type PendingResponseMap = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<serde_json::Value, String>>>>>;
const SIDECAR_RESPONSE_TIMEOUT_SECS: u64 = 45;
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "main-tray";
const TRAY_MENU_SHOW_ID: &str = "tray-show-main-window";
const TRAY_MENU_QUIT_ID: &str = "tray-quit-app";

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

struct DesktopShellState {
    is_quitting: AtomicBool,
    tray_icon: Mutex<Option<tauri::tray::TrayIcon<tauri::Wry>>>,
    tray_available: AtomicBool,
    window_behavior: Mutex<WindowBehavior>,
}

impl DesktopShellState {
    fn new() -> Self {
        Self {
            is_quitting: AtomicBool::new(false),
            tray_icon: Mutex::new(None),
            tray_available: AtomicBool::new(false),
            window_behavior: Mutex::new(WindowBehavior::default()),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
struct WindowBehavior {
    #[serde(default, rename = "minimizeToTray")]
    minimize_to_tray: bool,
    #[serde(default, rename = "closeToTray")]
    close_to_tray: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowBehaviorEvent {
    Minimize,
    CloseRequest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowAction {
    Allow,
    HideToTray,
}

#[derive(Debug, Default, Deserialize)]
struct PersistedGeneralSettings {
    #[serde(default, rename = "windowBehavior")]
    window_behavior: WindowBehavior,
}

#[derive(Debug, Default, Deserialize)]
struct PersistedSettingsFile {
    #[serde(default, rename = "generalSettings")]
    general_settings: PersistedGeneralSettings,
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

fn resolve_settings_path(config_dir: Option<&Path>, home_dir: Option<&Path>) -> PathBuf {
    if let Some(config_dir) = config_dir {
        return config_dir.join("settings.json");
    }

    if let Some(home_dir) = home_dir {
        return home_dir.join(".lume").join("settings.json");
    }

    PathBuf::from(".lume").join("settings.json")
}

fn current_settings_path() -> PathBuf {
    if let Ok(config_dir) = std::env::var("LUME_CONFIG_DIR") {
        let trimmed = config_dir.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            let resolved = if path.is_absolute() {
                path
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            };
            return resolve_settings_path(Some(resolved.as_path()), None);
        }
    }

    resolve_settings_path(None, dirs::home_dir().as_deref())
}

fn parse_window_behavior_from_settings_str(raw: &str) -> WindowBehavior {
    serde_json::from_str::<PersistedSettingsFile>(raw)
        .map(|settings| settings.general_settings.window_behavior)
        .unwrap_or_default()
}

fn read_window_behavior() -> WindowBehavior {
    let path = current_settings_path();
    match std::fs::read_to_string(&path) {
        Ok(raw) => parse_window_behavior_from_settings_str(&raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => WindowBehavior::default(),
        Err(error) => {
            warn!(
                "[desktop] failed to read settings.json for window behavior ({}): {error}",
                path.display()
            );
            WindowBehavior::default()
        }
    }
}

fn next_window_action(event: WindowBehaviorEvent, behavior: WindowBehavior) -> WindowAction {
    if event == WindowBehaviorEvent::Minimize && !behavior.minimize_to_tray {
        return WindowAction::Allow;
    }
    if event == WindowBehaviorEvent::CloseRequest && !behavior.close_to_tray {
        return WindowAction::Allow;
    }

    WindowAction::HideToTray
}

fn resolve_runtime_window_action(
    event: WindowBehaviorEvent,
    behavior: WindowBehavior,
    tray_available: bool,
    is_quitting: bool,
) -> WindowAction {
    if is_quitting || !tray_available {
        return WindowAction::Allow;
    }

    next_window_action(event, behavior)
}

fn get_cached_window_behavior(app: &tauri::AppHandle) -> WindowBehavior {
    app.try_state::<DesktopShellState>()
        .and_then(|state| state.window_behavior.lock().ok().map(|guard| *guard))
        .unwrap_or_default()
}

fn tray_is_available(app: &tauri::AppHandle) -> bool {
    app.try_state::<DesktopShellState>()
        .map(|state| state.tray_available.load(Ordering::Relaxed))
        .unwrap_or(false)
}

fn set_cached_window_behavior(app: &tauri::AppHandle, behavior: WindowBehavior) {
    if let Some(state) = app.try_state::<DesktopShellState>() {
        if let Ok(mut guard) = state.window_behavior.lock() {
            *guard = behavior;
        }
    }
}

#[tauri::command]
fn desktop_sync_window_behavior(
    window_behavior: WindowBehavior,
    state: tauri::State<'_, DesktopShellState>,
) -> Result<(), String> {
    let mut guard = state
        .window_behavior
        .lock()
        .map_err(|_| "desktop shell state poisoned".to_string())?;
    *guard = window_behavior;
    Ok(())
}

fn hide_window_to_tray(window: &tauri::WebviewWindow) {
    if let Err(error) = window.hide() {
        warn!("[desktop] failed to hide window to tray: {error}");
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(error) = window.unminimize() {
            warn!("[desktop] failed to unminimize main window: {error}");
        }
        if let Err(error) = window.show() {
            warn!("[desktop] failed to show main window: {error}");
            return;
        }
        if let Err(error) = window.set_focus() {
            warn!("[desktop] failed to focus main window: {error}");
        }
    } else {
        warn!("[desktop] main window not found when restoring from tray");
    }
}

fn build_tray_icon(app: &tauri::AppHandle) -> tauri::Result<tauri::tray::TrayIcon<tauri::Wry>> {
    let menu = tauri::menu::MenuBuilder::new(app)
        .text(TRAY_MENU_SHOW_ID, "Show Lume")
        .separator()
        .text(TRAY_MENU_QUIT_ID, "Quit")
        .build()?;

    let mut builder = tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event: tauri::menu::MenuEvent| {
            if event.id() == TRAY_MENU_SHOW_ID {
                show_main_window(app);
            } else if event.id() == TRAY_MENU_QUIT_ID {
                if let Some(state) = app.try_state::<DesktopShellState>() {
                    state.is_quitting.store(true, Ordering::Relaxed);
                }
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray: &tauri::tray::TrayIcon<tauri::Wry>, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Down,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)
}

fn spawn_sidecar_with_strategy(app: &tauri::AppHandle) -> Option<Child> {
    let prefer_env = env_flag_enabled("LUME_SIDECAR_PREFER_ENV");
    if prefer_env {
        return spawn_sidecar_from_env().or_else(|| spawn_sidecar_default(app));
    }

    if has_env_sidecar_cmd() && !LOGGED_ENV_CMD_IGNORED.swap(true, Ordering::Relaxed) {
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
    let mut child =
        spawn_sidecar_with_strategy(app).ok_or_else(|| "sidecar spawn failed".to_string())?;

    if let Some(stdout) = child.stdout.take() {
        spawn_sidecar_stdout_reader(stdout, Arc::clone(&state.pending), app.clone());
    } else {
        warn!("[desktop] sidecar stdout unavailable after spawn");
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_sidecar_stderr_reader(stderr);
    } else {
        warn!("[desktop] sidecar stderr unavailable after spawn");
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

#[tauri::command]
fn read_text_file(path: String) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("read selected file failed ({}): {e}", path))?;
    let truncated = text.len() > 512 * 1024;
    let content = if truncated {
        text.chars().take(512 * 1024).collect::<String>()
    } else {
        text
    };
    Ok(serde_json::json!({
        "content": content,
        "truncated": truncated
    }))
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
            warn!("[desktop] sidecar response timeout: id={request_id} method={method}");
            Err(format!("sidecar response timeout for method: {method}"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            warn!("[desktop] sidecar response disconnected: id={request_id} method={method}");
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
                Err(error) => {
                    warn!(
                        "[desktop] ignored non-json sidecar stdout line: {error}; line={trimmed}"
                    );
                    continue;
                }
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
        warn!("[desktop] sidecar stdout reader stopped: {close_reason}");
    });
}

fn spawn_sidecar_stderr_reader(stderr: ChildStderr) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    info!("[desktop] sidecar stderr reader stopped: EOF");
                    break;
                }
                Ok(_) => {}
                Err(error) => {
                    warn!("[desktop] read sidecar stderr failed: {error}");
                    break;
                }
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            info!("[sidecar] {trimmed}");
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
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        process.creation_flags(CREATE_NO_WINDOW);
    }

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

fn resolve_node_binary() -> String {
    if let Ok(configured) = std::env::var("LUME_SIDECAR_NODE") {
        if !configured.trim().is_empty() {
            return configured;
        }
    }
    "node".to_string()
}

fn resolve_mac_sidecar_bridge_path() -> Option<PathBuf> {
    let bridge_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/sidecar-node-bridge.mjs");
    if bridge_path.exists() {
        return Some(bridge_path);
    }
    None
}

fn bundled_sidecar_relative_path() -> &'static str {
    if cfg!(target_os = "windows") {
        "lume-sidecar.exe"
    } else {
        "lume-sidecar"
    }
}

fn resolve_bundled_sidecar_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(executable_dir) = current_exe.parent() {
            let sidecar_path = executable_dir.join(bundled_sidecar_relative_path());
            if sidecar_path.exists() {
                return Some(sidecar_path);
            }
        }
    }

    app.path()
        .resource_dir()
        .ok()
        .map(|resource_dir| resource_dir.join(bundled_sidecar_relative_path()))
        .filter(|path| path.exists())
}

fn resolve_default_skills_archive(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(configured) = std::env::var("LUME_DEFAULT_SKILLS_ARCHIVE") {
        if !configured.trim().is_empty() && PathBuf::from(&configured).exists() {
            return Some(configured);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for packaged_archive in [
            resource_dir.join("default-skills.tar"),
            resource_dir.join("resources").join("default-skills.tar"),
        ] {
            if packaged_archive.exists() {
                return Some(packaged_archive.to_string_lossy().to_string());
            }
        }
    }

    None
}

fn apply_default_skills_env(
    process: &mut Command,
    app: &tauri::AppHandle,
    sidecar_dir: &PathBuf,
) -> (Option<String>, Option<String>) {
    let archive = resolve_default_skills_archive(app);
    let directory = if archive.is_none() {
        resolve_default_skills_dir(app, sidecar_dir)
    } else {
        None
    };

    if let Some(archive_path) = archive.as_ref() {
        process.env("LUME_DEFAULT_SKILLS_ARCHIVE", archive_path);
    }
    if let Some(directory_path) = directory.as_ref() {
        process.env("LUME_DEFAULT_SKILLS_DIR", directory_path);
    }

    (archive, directory)
}

fn spawn_bundled_sidecar(app: &tauri::AppHandle) -> Option<Child> {
    let sidecar_path = resolve_bundled_sidecar_path(app)?;
    let mut process = Command::new(&sidecar_path);
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        process.creation_flags(CREATE_NO_WINDOW);
    }

    let (skills_archive, skills_dir) =
        apply_default_skills_env(&mut process, app, &PathBuf::from(""));

    match process.spawn() {
        Ok(child) => {
            info!(
                "[desktop] sidecar process booted from bundled binary: {} (default-skills-archive={}, default-skills-dir={})",
                sidecar_path.display(),
                skills_archive.as_deref().unwrap_or("not-found"),
                skills_dir.as_deref().unwrap_or("not-found")
            );
            Some(child)
        }
        Err(error) => {
            error!(
                "[desktop] failed to spawn bundled sidecar {}: {error}",
                sidecar_path.display()
            );
            None
        }
    }
}

fn build_mac_sidecar_bridge_args(
    bridge_path: &PathBuf,
    bun_bin: &str,
    sidecar_dir: &PathBuf,
    sidecar_entry: &PathBuf,
) -> Vec<String> {
    vec![
        bridge_path.to_string_lossy().to_string(),
        "--bun".to_string(),
        bun_bin.to_string(),
        "--cwd".to_string(),
        sidecar_dir.to_string_lossy().to_string(),
        "--entry".to_string(),
        sidecar_entry.to_string_lossy().to_string(),
    ]
}

fn resolve_default_skills_dir(app: &tauri::AppHandle, sidecar_dir: &PathBuf) -> Option<String> {
    if let Ok(configured) = std::env::var("LUME_DEFAULT_SKILLS_DIR") {
        if !configured.trim().is_empty() && PathBuf::from(&configured).exists() {
            return Some(configured);
        }
    }

    if !sidecar_dir.as_os_str().is_empty() {
        let dev_dir = sidecar_dir.join("default-skills");
        if dev_dir.exists() {
            return Some(dev_dir.to_string_lossy().to_string());
        }
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
    if !cfg!(debug_assertions) {
        if let Some(child) = spawn_bundled_sidecar(app) {
            return Some(child);
        }
        warn!("[desktop] bundled sidecar not found, falling back to development sidecar path");
    }

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
    let use_mac_node_bridge = cfg!(target_os = "macos");

    if use_mac_node_bridge {
        if let Some(bridge_path) = resolve_mac_sidecar_bridge_path() {
            let node_bin = resolve_node_binary();
            let bridge_args =
                build_mac_sidecar_bridge_args(&bridge_path, &bun_bin, &sidecar_dir, &sidecar_entry);
            let mut process = Command::new(&node_bin);
            process
                .args(&bridge_args)
                .current_dir(&sidecar_dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let (skills_archive, default_skills_dir) =
                apply_default_skills_env(&mut process, app, &sidecar_dir);

            match process.spawn() {
                Ok(child) => {
                    info!(
                        "[desktop] sidecar process booted from default path: {} (runtime=node-bridge-macos, entry={}, bun={}, node={}, bridge={}, default-skills-archive={}, default-skills-dir={})",
                        sidecar_dir.display(),
                        sidecar_entry.display(),
                        bun_bin,
                        node_bin,
                        bridge_path.display(),
                        skills_archive.as_deref().unwrap_or("not-found"),
                        default_skills_dir.as_deref().unwrap_or("not-found")
                    );
                    return Some(child);
                }
                Err(error) => {
                    error!(
                        "[desktop] failed to spawn macOS node bridge sidecar: {error}; fallback to bun-direct"
                    );
                }
            }
        } else {
            warn!("[desktop] macOS sidecar node bridge script not found; fallback to bun-direct");
        }
    }

    let mut process = Command::new(&bun_bin);
    process
        .arg(sidecar_entry.to_string_lossy().to_string())
        .current_dir(&sidecar_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (skills_archive, default_skills_dir) =
        apply_default_skills_env(&mut process, app, &sidecar_dir);

    match process.spawn() {
        Ok(child) => {
            info!(
                "[desktop] sidecar process booted from default path: {} (runtime=bun-direct, entry={}, bun={}, default-skills-archive={}, default-skills-dir={})",
                sidecar_dir.display(),
                sidecar_entry.display(),
                bun_bin,
                skills_archive.as_deref().unwrap_or("not-found"),
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

#[cfg(test)]
mod tests {
    use super::{
        build_mac_sidecar_bridge_args, next_window_action, parse_window_behavior_from_settings_str,
        resolve_runtime_window_action, resolve_settings_path, WindowAction, WindowBehavior,
        WindowBehaviorEvent,
    };
    use std::path::PathBuf;

    #[test]
    fn build_mac_sidecar_bridge_args_should_match_node_bridge_contract() {
        let args = build_mac_sidecar_bridge_args(
            &PathBuf::from("/repo/apps/desktop/scripts/sidecar-node-bridge.mjs"),
            "/bun",
            &PathBuf::from("/repo/apps/sidecar"),
            &PathBuf::from("/repo/apps/sidecar/src/index.ts"),
        );

        assert_eq!(
            args,
            vec![
                "/repo/apps/desktop/scripts/sidecar-node-bridge.mjs",
                "--bun",
                "/bun",
                "--cwd",
                "/repo/apps/sidecar",
                "--entry",
                "/repo/apps/sidecar/src/index.ts",
            ]
        );
    }

    #[test]
    fn parse_window_behavior_from_settings_str_reads_general_settings_namespace() {
        let behavior = parse_window_behavior_from_settings_str(
            r#"{
                "uiState": {
                    "currentConversationId": "conversation-1"
                },
                "generalSettings": {
                    "themeMode": "system",
                    "windowBehavior": {
                        "minimizeToTray": true,
                        "closeToTray": false
                    }
                }
            }"#,
        );

        assert_eq!(
            behavior,
            WindowBehavior {
                minimize_to_tray: true,
                close_to_tray: false,
            }
        );
    }

    #[test]
    fn parse_window_behavior_from_settings_str_defaults_when_missing_or_invalid() {
        assert_eq!(
            parse_window_behavior_from_settings_str("{}"),
            WindowBehavior::default()
        );
        assert_eq!(
            parse_window_behavior_from_settings_str("{ invalid json"),
            WindowBehavior::default()
        );
    }

    #[test]
    fn resolve_settings_path_matches_sidecar_convention() {
        assert_eq!(
            resolve_settings_path(
                Some(PathBuf::from("/tmp/custom-lume").as_path()),
                Some(PathBuf::from("/Users/demo").as_path()),
            ),
            PathBuf::from("/tmp/custom-lume/settings.json")
        );

        assert_eq!(
            resolve_settings_path(None, Some(PathBuf::from("/Users/demo").as_path())),
            PathBuf::from("/Users/demo/.lume/settings.json")
        );
    }

    #[test]
    fn next_window_action_uses_behavior_toggles_per_event() {
        let behavior = WindowBehavior {
            minimize_to_tray: true,
            close_to_tray: false,
        };

        assert_eq!(
            next_window_action(WindowBehaviorEvent::Minimize, behavior),
            WindowAction::HideToTray
        );
        assert_eq!(
            next_window_action(WindowBehaviorEvent::CloseRequest, behavior),
            WindowAction::Allow
        );

        let behavior = WindowBehavior {
            minimize_to_tray: false,
            close_to_tray: true,
        };

        assert_eq!(
            next_window_action(WindowBehaviorEvent::CloseRequest, behavior),
            WindowAction::HideToTray
        );
    }

    #[test]
    fn resolve_runtime_window_action_allows_default_behavior_when_tray_is_unavailable_or_app_is_quitting()
    {
        let behavior = WindowBehavior {
            minimize_to_tray: true,
            close_to_tray: true,
        };

        assert_eq!(
            resolve_runtime_window_action(
                WindowBehaviorEvent::Minimize,
                behavior,
                false,
                false
            ),
            WindowAction::Allow
        );

        assert_eq!(
            resolve_runtime_window_action(
                WindowBehaviorEvent::CloseRequest,
                behavior,
                true,
                true
            ),
            WindowAction::Allow
        );
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
    let updater_pubkey = option_env!("LUME_UPDATER_PUBLIC_KEY")
        .unwrap_or("__LUME_UPDATER_PUBLIC_KEY__")
        .to_string();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().pubkey(updater_pubkey).build())
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
        .manage(DesktopShellState::new())
        .setup(|app| {
            let state = app.state::<SidecarProcess>();
            if let Some(mut child) = spawn_sidecar_with_strategy(&app.handle()) {
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
            }

            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                window.open_devtools();
            }

            let tray_state = app.state::<DesktopShellState>();
            set_cached_window_behavior(&app.handle(), read_window_behavior());
            match build_tray_icon(&app.handle()) {
                Ok(tray_icon) => {
                    tray_state.tray_available.store(true, Ordering::Relaxed);
                    if let Ok(mut slot) = tray_state.tray_icon.lock() {
                        *slot = Some(tray_icon);
                    }
                }
                Err(error) => {
                    tray_state.tray_available.store(false, Ordering::Relaxed);
                    warn!("[desktop] tray initialization unavailable, continuing without tray support: {error}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            sidecar_healthcheck,
            sidecar_call,
            desktop_sync_window_behavior,
            open_file_dialog,
            open_folder_dialog,
            open_external,
            read_text_file
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    if label == MAIN_WINDOW_LABEL {
                        let is_quitting = app
                            .try_state::<DesktopShellState>()
                            .map(|state| state.is_quitting.load(Ordering::Relaxed))
                            .unwrap_or(false);
                        if !is_quitting {
                            match event {
                                tauri::WindowEvent::CloseRequested { api, .. } => {
                                    let behavior = get_cached_window_behavior(&app);
                                    if resolve_runtime_window_action(
                                        WindowBehaviorEvent::CloseRequest,
                                        behavior,
                                        tray_is_available(&app),
                                        is_quitting,
                                    ) == WindowAction::HideToTray
                                    {
                                        api.prevent_close();
                                        if let Some(window) =
                                            app.get_webview_window(MAIN_WINDOW_LABEL)
                                        {
                                            hide_window_to_tray(&window);
                                        }
                                    }
                                }
                                tauri::WindowEvent::Resized(_) => {
                                    let behavior = get_cached_window_behavior(&app);
                                    if resolve_runtime_window_action(
                                        WindowBehaviorEvent::Minimize,
                                        behavior,
                                        tray_is_available(&app),
                                        is_quitting,
                                    ) == WindowAction::HideToTray
                                    {
                                        if let Some(window) =
                                            app.get_webview_window(MAIN_WINDOW_LABEL)
                                        {
                                            match window.is_minimized() {
                                                Ok(true) => hide_window_to_tray(&window),
                                                Ok(false) => {}
                                                Err(error) => warn!(
                                                    "[desktop] failed to inspect main window minimized state: {error}"
                                                ),
                                            }
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                tauri::RunEvent::Exit => {
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
                _ => {}
            }
        });
}
