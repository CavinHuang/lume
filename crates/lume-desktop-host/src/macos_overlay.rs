use std::{
    io::Write,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Mutex, OnceLock},
};

const OVERLAY_BINARY_NAME: &str = "LumeComputerUseCursorOverlay";
const OVERLAY_ASSET_NAME: &str = "official-software-cursor-window-252.png";

struct OverlayProcess {
    child: Child,
    stdin: ChildStdin,
}

pub fn move_cursor(x: i64, y: i64) -> bool {
    send(&format!("move {x} {y}\n"))
}

pub fn pulse_cursor(x: i64, y: i64) -> bool {
    send(&format!("pulse {x} {y}\n"))
}

pub fn hide_cursor() {
    let _ = send("hide\n");
}

fn send(command: &str) -> bool {
    let mut process = overlay_process()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if process.is_none() {
        *process = spawn_overlay();
    }
    if process
        .as_mut()
        .and_then(|active| active.child.try_wait().ok().flatten())
        .is_some()
    {
        *process = spawn_overlay();
    }
    let Some(active) = process.as_mut() else {
        return false;
    };
    if active.stdin.write_all(command.as_bytes()).is_ok() && active.stdin.flush().is_ok() {
        return true;
    }
    let _ = active.child.kill();
    *process = spawn_overlay();
    process
        .as_mut()
        .is_some_and(|active| active.stdin.write_all(command.as_bytes()).is_ok())
}

fn overlay_process() -> &'static Mutex<Option<OverlayProcess>> {
    static PROCESS: OnceLock<Mutex<Option<OverlayProcess>>> = OnceLock::new();
    PROCESS.get_or_init(|| Mutex::new(None))
}

fn spawn_overlay() -> Option<OverlayProcess> {
    let executable = std::env::current_exe().ok()?;
    let macos_dir = executable.parent()?;
    let contents_dir = macos_dir.parent()?;
    let helper = macos_dir.join(OVERLAY_BINARY_NAME);
    let asset = contents_dir.join("Resources").join(OVERLAY_ASSET_NAME);
    if !helper.is_file() || !asset.is_file() {
        return None;
    }
    spawn_overlay_at(helper, asset)
}

fn spawn_overlay_at(helper: PathBuf, asset: PathBuf) -> Option<OverlayProcess> {
    let mut child = Command::new(helper)
        .arg(asset)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdin = child.stdin.take()?;
    Some(OverlayProcess { child, stdin })
}
