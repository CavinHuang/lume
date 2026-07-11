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
fn context_changed_event(event_type: &str, occurred_at: u128) -> Value {
    json!({
        "method": "context.event",
        "params": {
            "type": event_type,
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
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            WindowsAndMessaging::{
                CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
                UnhookWindowsHookEx, EVENT_OBJECT_FOCUS, EVENT_OBJECT_SELECTION,
                EVENT_OBJECT_SELECTIONADD, EVENT_OBJECT_SELECTIONREMOVE,
                EVENT_OBJECT_SELECTIONWITHIN, EVENT_OBJECT_VALUECHANGE, EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_SCROLLINGEND, EVENT_SYSTEM_SCROLLINGSTART, MSG, PM_NOREMOVE,
                WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT, WM_LBUTTONUP, WM_MBUTTONUP, WM_MOUSEHWHEEL,
                WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONUP,
            },
        },
    };

    fn senders() -> &'static Mutex<HashMap<usize, UnboundedSender<Value>>> {
        static SENDERS: OnceLock<Mutex<HashMap<usize, UnboundedSender<Value>>>> = OnceLock::new();
        SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn mouse_sender() -> &'static Mutex<Option<UnboundedSender<Value>>> {
        static SENDER: OnceLock<Mutex<Option<UnboundedSender<Value>>>> = OnceLock::new();
        SENDER.get_or_init(|| Mutex::new(None))
    }

    unsafe extern "system" fn event_callback(
        hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        _object_id: i32,
        _child_id: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        let event_type = match event {
            EVENT_SYSTEM_FOREGROUND => "foreground_changed",
            EVENT_OBJECT_FOCUS => "focus_changed",
            EVENT_OBJECT_SELECTION
            | EVENT_OBJECT_SELECTIONADD
            | EVENT_OBJECT_SELECTIONREMOVE
            | EVENT_OBJECT_SELECTIONWITHIN => "selection_changed",
            EVENT_OBJECT_VALUECHANGE => "value_changed",
            EVENT_SYSTEM_SCROLLINGSTART | EVENT_SYSTEM_SCROLLINGEND => "scroll_changed",
            _ => return,
        };
        if hwnd.0.is_null() {
            return;
        }
        if let Some(sender) = senders()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&(hook.0 as usize))
        {
            let _ = sender.send(context_changed_event(event_type, now_millis()));
        }
    }

    unsafe extern "system" fn mouse_callback(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let event_type = match wparam.0 as u32 {
                WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP => Some("interaction_changed"),
                WM_MOUSEWHEEL | WM_MOUSEHWHEEL => Some("scroll_changed"),
                _ => None,
            };
            if let Some(event_type) = event_type {
                if let Some(sender) = mouse_sender()
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_ref()
                {
                    let _ = sender.send(context_changed_event(event_type, now_millis()));
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    let (sender, receiver) = mpsc::unbounded_channel();
    let (ready_sender, ready_receiver) = std_mpsc::sync_channel(1);
    let thread = thread::spawn(move || unsafe {
        let thread_id = GetCurrentThreadId();
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        let ranges = [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_SCROLLINGSTART, EVENT_SYSTEM_SCROLLINGEND),
            (EVENT_OBJECT_FOCUS, EVENT_OBJECT_FOCUS),
            (EVENT_OBJECT_SELECTION, EVENT_OBJECT_SELECTIONWITHIN),
            (EVENT_OBJECT_VALUECHANGE, EVENT_OBJECT_VALUECHANGE),
        ];
        let hooks = ranges
            .into_iter()
            .map(|(event_min, event_max)| {
                SetWinEventHook(
                    event_min,
                    event_max,
                    None,
                    Some(event_callback),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            })
            .collect::<Vec<_>>();
        if hooks.iter().any(|hook| hook.is_invalid()) {
            for hook in hooks.into_iter().filter(|hook| !hook.is_invalid()) {
                let _ = UnhookWinEvent(hook);
            }
            let _ = ready_sender.send(Err("SetWinEventHook failed".to_owned()));
            return;
        }
        {
            let mut registered = senders().lock().unwrap_or_else(|error| error.into_inner());
            for hook in &hooks {
                registered.insert(hook.0 as usize, sender.clone());
            }
        }
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_callback), None, 0).ok();
        *mouse_sender()
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(sender);
        let _ = ready_sender.send(Ok(thread_id));
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {}
        *mouse_sender()
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        if let Some(mouse_hook) = mouse_hook {
            let _ = UnhookWindowsHookEx(mouse_hook);
        }
        let mut registered = senders().lock().unwrap_or_else(|error| error.into_inner());
        for hook in hooks {
            registered.remove(&(hook.0 as usize));
            let _ = UnhookWinEvent(hook);
        }
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
    fn context_events_contain_no_desktop_content() {
        for event_type in [
            "foreground_changed",
            "focus_changed",
            "selection_changed",
            "value_changed",
            "scroll_changed",
            "interaction_changed",
        ] {
            assert_eq!(
                context_changed_event(event_type, 123),
                json!({
                    "method": "context.event",
                    "params": { "type": event_type, "occurredAt": 123 },
                }),
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn starts_and_stops_the_windows_foreground_hook() {
        let monitor = start_desktop_event_monitor().unwrap();
        drop(monitor);
    }
}
