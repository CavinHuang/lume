#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose, Engine as _};
use log::{error, info, warn};
use serde::Deserialize;
use tauri::webview::PageLoadEvent;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

const SIDECAR_RESPONSE_TIMEOUT_SECS: u64 = 45;
const MAIN_WINDOW_LABEL: &str = "main";
const WEREAD_KEY_WINDOW_LABEL: &str = "weread-key";
const WEREAD_KEY_PAGE_URL: &str = "https://weread.qq.com/r/weread-skills";
const TRAY_ID: &str = "main-tray";
const TRAY_MENU_SHOW_ID: &str = "tray-show-main-window";
const TRAY_MENU_QUIT_ID: &str = "tray-quit-app";

struct PendingSidecarRequest {
    method: String,
    tx: mpsc::Sender<Result<serde_json::Value, String>>,
}

type PendingResponseMap = Arc<Mutex<HashMap<u64, PendingSidecarRequest>>>;

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

#[derive(Debug, Deserialize)]
struct FileDialogFilter {
    name: String,
    extensions: Vec<String>,
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

fn resolve_logs_dir(config_dir: Option<&Path>, home_dir: Option<&Path>) -> PathBuf {
    if let Some(config_dir) = config_dir {
        return config_dir.join("logs");
    }

    if let Some(home_dir) = home_dir {
        return home_dir.join(".lume").join("logs");
    }

    PathBuf::from(".lume").join("logs")
}

fn current_config_dir_from_env() -> Option<PathBuf> {
    let config_dir = std::env::var("LUME_CONFIG_DIR").ok()?;
    let trimmed = config_dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    Some(if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    })
}

fn civil_date_from_unix_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month as u32, day as u32)
}

fn current_utc_date_str() -> String {
    let days_since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400;
    let (year, month, day) = civil_date_from_unix_days(days_since_epoch as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

fn current_log_file_name(date: &str) -> String {
    format!("lume-{date}.log")
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
        out.push(file_metadata_json(&file_path)?);
    }

    Ok(serde_json::json!({ "files": out }))
}

#[tauri::command]
fn stat_file_paths(paths: Vec<String>) -> Result<serde_json::Value, String> {
    let mut out = Vec::<serde_json::Value>::new();
    for path in paths {
        out.push(file_metadata_json(Path::new(&path))?);
    }
    Ok(serde_json::json!({ "files": out }))
}

fn file_metadata_json(file_path: &Path) -> Result<serde_json::Value, String> {
    let metadata = std::fs::metadata(file_path)
        .map_err(|e| format!("stat file failed ({}): {e}", file_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("path is not a file: {}", file_path.display()));
    }
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
    let mut payload = serde_json::json!({
        "filename": filename,
        "mediaType": media_type,
        "size": metadata.len() as usize,
        "sourcePath": file_path.to_string_lossy().to_string()
    });

    if media_type.starts_with("image/") {
        let bytes = std::fs::read(file_path)
            .map_err(|e| format!("read image file failed ({}): {e}", file_path.display()))?;
        payload["data"] = serde_json::Value::String(general_purpose::STANDARD.encode(bytes));
    }

    Ok(payload)
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
async fn open_weread_key_webview(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = parse_weread_key_url(&url)?;
    if let Some(window) = app.get_webview_window(WEREAD_KEY_WINDOW_LABEL) {
        window
            .navigate(url)
            .map_err(|e| format!("navigate WeRead key window failed: {e}"))?;
        window
            .show()
            .map_err(|e| format!("show WeRead key window failed: {e}"))?;
        window
            .set_focus()
            .map_err(|e| format!("focus WeRead key window failed: {e}"))?;
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        WEREAD_KEY_WINDOW_LABEL,
        tauri::WebviewUrl::External(url),
    )
    .title("微信读书 API KEY")
    .inner_size(1000.0, 720.0)
    .resizable(true)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            inject_weread_key_tip(&window);
        }
    })
    .build()
    .map_err(|e| format!("open WeRead key window failed: {e}"))?;

    Ok(())
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    read_system_clipboard_text()
}

fn parse_weread_key_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|e| format!("invalid WeRead key url: {e}"))?;
    if url.scheme() != "https" || url.host_str() != Some("weread.qq.com") || url.path() != "/r/weread-skills" {
        return Err(format!("only {WEREAD_KEY_PAGE_URL} is allowed"));
    }
    Ok(url)
}

fn inject_weread_key_tip(window: &tauri::WebviewWindow) {
    let message = serde_json::to_string(
        "请关闭快捷登录弹窗，用微信扫码登录；获取 API KEY 后 Lume 会自动读取并填入。"
    )
    .unwrap_or_else(|_| "\"请用微信扫码登录并获取 API KEY\"".to_string());
    let script = format!(
        r#"(function() {{
  if (document.getElementById('lume-weread-key-tip')) return;
  var tip = document.createElement('div');
  tip.id = 'lume-weread-key-tip';
  tip.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#ecfdf3;color:#166534;font-size:14px;text-align:center;border-bottom:1px solid #bbf7d0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  tip.textContent = {message};
  document.body && document.body.appendChild(tip);
}})();"#
    );
    if let Err(error) = window.eval(script) {
        warn!("[desktop] failed to inject WeRead key tip: {error}");
    }
}

fn read_system_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        return command_output_text("pbpaste", &[]);
    }

    #[cfg(target_os = "windows")]
    {
        return command_output_text("powershell", &["-NoProfile", "-Command", "Get-Clipboard -Raw"]);
    }

    #[cfg(target_os = "linux")]
    {
        return command_output_text("wl-paste", &["--no-newline"])
            .or_else(|_| command_output_text("xclip", &["-selection", "clipboard", "-o"]))
            .or_else(|_| command_output_text("xsel", &["--clipboard", "--output"]));
    }

    #[allow(unreachable_code)]
    Err("clipboard is not supported on this platform".to_string())
}

fn command_output_text(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("read clipboard failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "read clipboard failed".to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn save_text_file_dialog(filename: String, content: String) -> Result<serde_json::Value, String> {
    let path = rfd::FileDialog::new()
        .set_file_name(&filename)
        .save_file()
        .ok_or_else(|| "用户取消了保存".to_string())?;
    std::fs::write(&path, content.as_bytes())
        .map_err(|e| format!("保存文件失败 ({}): {e}", path.display()))?;
    Ok(serde_json::json!({ "path": path.to_string_lossy().to_string() }))
}

#[tauri::command]
fn save_file_path_dialog(
    filename: String,
    filters: Option<Vec<FileDialogFilter>>,
) -> Result<serde_json::Value, String> {
    let mut dialog = rfd::FileDialog::new().set_file_name(&filename);
    if let Some(filters) = filters {
        for filter in filters {
            if filter.extensions.is_empty() {
                continue;
            }
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &extensions);
        }
    } else {
        dialog = dialog.add_filter("SVG 图片", &["svg"]);
    }
    let path = dialog.save_file();
    Ok(serde_json::json!({
        "path": path.map(|item| item.to_string_lossy().to_string())
    }))
}

#[tauri::command]
fn write_binary_file(path: String, base64_content: String) -> Result<serde_json::Value, String> {
    let bytes = general_purpose::STANDARD
        .decode(base64_content)
        .map_err(|e| format!("图片数据解析失败: {e}"))?;
    std::fs::write(&path, bytes)
        .map_err(|e| format!("保存文件失败 ({}): {e}", path))?;
    Ok(serde_json::json!({ "path": path }))
}

#[tauri::command]
fn open_in_system(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn reveal_path_in_system(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let target = p
        .canonicalize()
        .map_err(|e| format!("解析路径失败 ({path}): {e}"))?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("定位失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", target.to_string_lossy()))
            .spawn()
            .map_err(|e| format!("定位失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let folder = if target.is_dir() {
            target
        } else {
            target
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| format!("无法定位文件夹: {path}"))?
        };
        std::process::Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|e| format!("打开所在文件夹失败: {e}"))?;
    }
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

fn describe_sidecar_method(method: &str) -> &'static str {
    match method {
        "general-settings:list-log-files" => "读取本地日志文件列表",
        "general-settings:read-log-file" => "读取当前选中的日志文件内容",
        "general-settings:export-logs" => "导出全部本地日志",
        "general-settings:open-logs-dir" => "打开本地日志目录",
        "general-settings:get" => "读取通用设置",
        "general-settings:update" => "保存通用设置",
        "agent:get-proxy-settings" => "读取 sidecar 网络代理配置",
        "agent:save-proxy-settings" => "保存 sidecar 网络代理配置",
        "healthcheck" => "检查 sidecar 进程健康状态",
        _ => "执行前端与 sidecar 后端之间的数据请求",
    }
}

fn summarize_sidecar_result(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(value) => format!("bool({value})"),
        serde_json::Value::Number(_) => "number".to_string(),
        serde_json::Value::String(value) => format!("string(len={})", value.chars().count()),
        serde_json::Value::Array(items) => format!("array(len={})", items.len()),
        serde_json::Value::Object(object) => {
            if object.is_empty() {
                return "object(empty)".to_string();
            }
            let mut keys = object.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            keys.truncate(6);
            format!("object(keys={})", keys.join(","))
        }
    }
}

fn format_sidecar_call_started(request_id: u64, method: &str) -> String {
    format!(
        "[desktop] 调用 sidecar 接口: id={request_id} method={method} 用途={}",
        describe_sidecar_method(method)
    )
}

fn format_sidecar_request_sent(request_id: u64, method: &str) -> String {
    format!("[desktop] sidecar 请求已发送: id={request_id} method={method} 状态=等待响应")
}

fn format_sidecar_call_succeeded(
    request_id: u64,
    method: &str,
    result: &serde_json::Value,
) -> String {
    format!(
        "[desktop] sidecar 调用成功: id={request_id} method={method} 结果={}",
        summarize_sidecar_result(result)
    )
}

fn format_sidecar_call_failed(request_id: u64, method: &str, error: &str) -> String {
    format!("[desktop] sidecar 调用失败: id={request_id} method={method} 错误={error}")
}

async fn sidecar_call_internal(
    state: &tauri::State<'_, SidecarProcess>,
    method: &str,
    params: serde_json::Value,
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    ensure_sidecar_running(state, app)?;
    let request_id = NEXT_RPC_ID.fetch_add(1, Ordering::Relaxed);
    info!("{}", format_sidecar_call_started(request_id, method));

    let (tx, rx) = mpsc::channel::<Result<serde_json::Value, String>>();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "sidecar pending map lock poisoned".to_string())?;
        pending.insert(
            request_id,
            PendingSidecarRequest {
                method: method.to_string(),
                tx,
            },
        );
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
            warn!(
                "{}",
                format_sidecar_call_failed(
                    request_id,
                    method,
                    &format!("写入请求失败: {error}")
                )
            );
            return Err(format!("write sidecar request failed: {error}"));
        }

        if let Err(error) = stdin.flush() {
            remove_pending_request(state, request_id);
            if is_broken_pipe_error_message(&error.to_string()) {
                if let Ok(mut slot) = state.child.lock() {
                    *slot = None;
                }
            }
            warn!(
                "{}",
                format_sidecar_call_failed(
                    request_id,
                    method,
                    &format!("刷新请求失败: {error}")
                )
            );
            return Err(format!("flush sidecar request failed: {error}"));
        }
    }
    info!("{}", format_sidecar_request_sent(request_id, method));

    let recv_result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(SIDECAR_RESPONSE_TIMEOUT_SECS))
    })
    .await
    .map_err(|error| format!("sidecar wait task join failed: {error}"))?;

    match recv_result {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            remove_pending_request(state, request_id);
            warn!(
                "{}",
                format_sidecar_call_failed(request_id, method, "等待 sidecar 响应超时")
            );
            Err(format!("sidecar response timeout for method: {method}"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            warn!(
                "{}",
                format_sidecar_call_failed(request_id, method, "sidecar 响应通道已断开")
            );
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
                let pending_request = pending
                    .lock()
                    .ok()
                    .and_then(|mut waiters| waiters.remove(&response_id));
                if let Some(request) = pending_request {
                    if let Some(error) = parsed.get("error") {
                        let message = error
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown sidecar error");
                        warn!(
                            "{}",
                            format_sidecar_call_failed(response_id, &request.method, message)
                        );
                        let _ = request.tx.send(Err(message.to_string()));
                    } else {
                        let result = parsed
                            .get("result")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        info!(
                            "{}",
                            format_sidecar_call_succeeded(response_id, &request.method, &result)
                        );
                        let _ = request.tx.send(Ok(result));
                    }
                } else {
                    warn!(
                        "[desktop] sidecar 响应已收到但没有匹配请求: id={response_id} method=unknown"
                    );
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
            for (request_id, request) in waiters.drain() {
                warn!(
                    "{}",
                    format_sidecar_call_failed(request_id, &request.method, &close_reason)
                );
                let _ = request.tx.send(Err(close_reason.clone()));
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
    apply_sidecar_logging_env(&mut process);

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

fn apply_sidecar_logging_env(process: &mut Command) {
    process.env("LUME_LOG_FILE", "false");
    process.env("LUME_LOG_CONSOLE", "true");
}

fn spawn_bundled_sidecar(app: &tauri::AppHandle) -> Option<Child> {
    let sidecar_path = resolve_bundled_sidecar_path(app)?;
    let mut process = Command::new(&sidecar_path);
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_sidecar_logging_env(&mut process);

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
            apply_sidecar_logging_env(&mut process);
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
    apply_sidecar_logging_env(&mut process);
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
        apply_sidecar_logging_env, build_mac_sidecar_bridge_args, current_log_file_name,
        format_sidecar_call_failed, format_sidecar_call_started, format_sidecar_call_succeeded,
        format_sidecar_request_sent, next_window_action,
        parse_window_behavior_from_settings_str, resolve_runtime_window_action,
        resolve_settings_path, WindowAction, WindowBehavior, WindowBehaviorEvent,
    };
    use std::path::PathBuf;
    use std::process::Command;

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
    fn sidecar_rpc_log_messages_are_human_readable() {
        assert_eq!(
            format_sidecar_call_started(12, "general-settings:list-log-files"),
            "[desktop] 调用 sidecar 接口: id=12 method=general-settings:list-log-files 用途=读取本地日志文件列表"
        );
        assert_eq!(
            format_sidecar_request_sent(12, "general-settings:list-log-files"),
            "[desktop] sidecar 请求已发送: id=12 method=general-settings:list-log-files 状态=等待响应"
        );
        assert_eq!(
            format_sidecar_call_succeeded(
                12,
                "general-settings:list-log-files",
                &serde_json::json!({
                    "files": [],
                    "totalFiles": 0,
                    "totalBytes": 0
                })
            ),
            "[desktop] sidecar 调用成功: id=12 method=general-settings:list-log-files 结果=object(keys=files,totalBytes,totalFiles)"
        );
        assert_eq!(
            format_sidecar_call_failed(12, "general-settings:list-log-files", "boom"),
            "[desktop] sidecar 调用失败: id=12 method=general-settings:list-log-files 错误=boom"
        );
    }

    #[test]
    fn desktop_and_sidecar_share_single_daily_log_file() {
        assert_eq!(current_log_file_name("2026-05-29"), "lume-2026-05-29.log");

        let mut command = Command::new("sidecar");
        apply_sidecar_logging_env(&mut command);
        let envs = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|item| item.to_string_lossy().to_string()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();

        assert_eq!(envs.get("LUME_LOG_FILE"), Some(&Some("false".to_string())));
        assert_eq!(envs.get("LUME_LOG_CONSOLE"), Some(&Some("true".to_string())));
    }

    #[test]
    fn parse_window_behavior_from_settings_str_reads_general_settings_namespace() {
        let behavior = parse_window_behavior_from_settings_str(
            r#"{
                "uiState": {
                    "currentAgentThreadId": "thread-1"
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
    let env_config_dir = current_config_dir_from_env();
    let logs_dir = resolve_logs_dir(env_config_dir.as_deref(), dirs::home_dir().as_deref());
    if !logs_dir.exists() {
        let _ = std::fs::create_dir_all(&logs_dir);
    }
    logs_dir
}

fn main() {
    // 获取日志目录
    let logs_dir = get_logs_dir();
    let log_file_name = current_log_file_name(&current_utc_date_str());
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
                    Target::new(TargetKind::Folder { path: logs_dir.clone(), file_name: Some(log_file_name.into()) }),  // 文件输出
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
            stat_file_paths,
            open_folder_dialog,
            open_external,
            open_weread_key_webview,
            read_clipboard_text,
            read_text_file,
            save_text_file_dialog,
            save_file_path_dialog,
            write_binary_file,
            open_in_system,
            reveal_path_in_system
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
