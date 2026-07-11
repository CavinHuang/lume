use anyhow::{anyhow, Context, Result};
#[cfg(any(windows, test))]
use serde_json::json;
use serde_json::Value;
#[cfg(any(windows, test))]
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::{self, UnboundedReceiver};

pub struct DesktopEventMonitor {
    receiver: UnboundedReceiver<Value>,
    stop: Option<Box<dyn FnOnce() + Send>>,
}

impl DesktopEventMonitor {
    pub async fn recv(&mut self) -> Option<Value> {
        self.receiver.recv().await
    }
}

impl Drop for DesktopEventMonitor {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

pub fn start_desktop_event_monitor() -> Result<DesktopEventMonitor> {
    #[cfg(windows)]
    return start_windows_event_monitor();
    #[cfg(target_os = "macos")]
    return start_macos_event_monitor();
    #[allow(unreachable_code)]
    Err(anyhow!(
        "desktop event monitor is unsupported on this platform"
    ))
}

#[cfg(any(windows, test))]
fn foreground_changed_event(occurred_at: u128) -> Value {
    json!({
        "method": "context.event",
        "params": {
            "type": "foreground_changed",
            "occurredAt": occurred_at,
        },
    })
}

#[cfg(any(windows, test))]
fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(windows)]
fn start_windows_event_monitor() -> Result<DesktopEventMonitor> {
    use std::{
        collections::HashMap,
        sync::{mpsc as std_mpsc, Mutex, OnceLock},
        thread,
        time::Duration,
    };
    use tokio::sync::mpsc::UnboundedSender;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            WindowsAndMessaging::{
                GetMessageW, PeekMessageW, PostThreadMessageW, EVENT_SYSTEM_FOREGROUND, MSG,
                PM_NOREMOVE, WINEVENT_OUTOFCONTEXT, WM_QUIT,
            },
        },
    };

    fn senders() -> &'static Mutex<HashMap<usize, UnboundedSender<Value>>> {
        static SENDERS: OnceLock<Mutex<HashMap<usize, UnboundedSender<Value>>>> = OnceLock::new();
        SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    unsafe extern "system" fn foreground_callback(
        hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        _object_id: i32,
        _child_id: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        if event != EVENT_SYSTEM_FOREGROUND || hwnd.0.is_null() {
            return;
        }
        if let Some(sender) = senders()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&(hook.0 as usize))
        {
            let _ = sender.send(foreground_changed_event(now_millis()));
        }
    }

    let (sender, receiver) = mpsc::unbounded_channel();
    let (ready_sender, ready_receiver) = std_mpsc::sync_channel(1);
    let thread = thread::spawn(move || unsafe {
        let thread_id = GetCurrentThreadId();
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if hook.is_invalid() {
            let _ = ready_sender.send(Err("SetWinEventHook failed".to_owned()));
            return;
        }
        senders()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(hook.0 as usize, sender);
        let _ = ready_sender.send(Ok(thread_id));
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {}
        senders()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&(hook.0 as usize));
        let _ = UnhookWinEvent(hook);
    });
    let thread_id = ready_receiver
        .recv_timeout(Duration::from_secs(2))
        .context("Windows desktop event monitor did not start")?
        .map_err(|message| anyhow!(message))?;
    Ok(DesktopEventMonitor {
        receiver,
        stop: Some(Box::new(move || {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            let _ = thread.join();
        })),
    })
}

#[cfg(target_os = "macos")]
fn start_macos_event_monitor() -> Result<DesktopEventMonitor> {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        sync::{Arc, Mutex},
        thread,
    };

    const HELPER_NAME: &str = "LumeComputerUseEventMonitor";
    let helper = std::env::current_exe()
        .context("locate desktop host executable")?
        .parent()
        .map(|parent| parent.join(HELPER_NAME))
        .filter(|path| path.is_file())
        .ok_or_else(|| anyhow!("macOS desktop event helper is unavailable"))?;
    let mut child = Command::new(helper)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("start macOS desktop event helper")?;
    let stdout = child
        .stdout
        .take()
        .context("macOS desktop event helper stdout is unavailable")?;
    let child = Arc::new(Mutex::new(child));
    let (sender, receiver) = mpsc::unbounded_channel();
    let reader_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|line| line.ok()) {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if sender.send(event).is_err() {
                break;
            }
        }
    });
    Ok(DesktopEventMonitor {
        receiver,
        stop: Some(Box::new(move || {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = reader_thread.join();
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_events_contain_no_desktop_content() {
        assert_eq!(
            foreground_changed_event(123),
            json!({
                "method": "context.event",
                "params": { "type": "foreground_changed", "occurredAt": 123 },
            }),
        );
    }

    #[cfg(windows)]
    #[test]
    fn starts_and_stops_the_windows_foreground_hook() {
        let monitor = start_desktop_event_monitor().unwrap();
        drop(monitor);
    }
}
