#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct SidecarProcess(Mutex<Option<Child>>);

#[tauri::command]
fn healthcheck() -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "source": "desktop"
    })
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
        .stdin(Stdio::null())
        .stdout(Stdio::null())
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
        .invoke_handler(tauri::generate_handler![healthcheck])
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

