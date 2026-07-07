use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use windows::{
    core::w,
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{
            BeginPaint, CreatePen, CreateSolidBrush, DeleteObject, Ellipse, EndPaint, FillRect,
            InvalidateRect, Polygon, SelectObject, UpdateWindow, HDC, HGDIOBJ, PAINTSTRUCT,
            PS_SOLID,
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetWindow,
            GetWindowRect, IsWindow, PeekMessageW, RegisterClassW, SetLayeredWindowAttributes,
            SetWindowPos, ShowWindow, TranslateMessage, GW_HWNDPREV, HWND_TOP, LWA_COLORKEY, MSG,
            PM_REMOVE, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE,
            WM_PAINT, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            WS_EX_TRANSPARENT, WS_POPUP,
        },
    },
};

const WINDOW_SIZE: i32 = 96;
const TIP_X: i32 = 42;
const TIP_Y: i32 = 34;
const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const MOVE_DURATION: Duration = Duration::from_millis(144);
const CLICK_DURATION: Duration = Duration::from_millis(220);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const TRANSPARENT_KEY: COLORREF = COLORREF(0x00ff_00ff);
pub(crate) const VISUAL_CURSOR_WINDOW_TITLE: &str = "Lume Visual Cursor";
static CLICK_PROGRESS_MILLI: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorPoint {
    pub x: f64,
    pub y: f64,
}

pub fn cursor_motion_point(start: CursorPoint, end: CursorPoint, progress: f64) -> CursorPoint {
    let t = progress.clamp(0.0, 1.0);
    if t == 0.0 {
        return start;
    }
    if t == 1.0 {
        return end;
    }
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let control1 = CursorPoint {
        x: start.x + dx * 0.28,
        y: start.y + dy * 0.08,
    };
    let control2 = CursorPoint {
        x: start.x + dx * 0.72,
        y: start.y + dy * 0.92,
    };
    cubic_point(start, control1, control2, end, ease_out_cubic(t))
}

fn cubic_point(
    start: CursorPoint,
    control1: CursorPoint,
    control2: CursorPoint,
    end: CursorPoint,
    t: f64,
) -> CursorPoint {
    let inverse = 1.0 - t;
    let a = inverse * inverse * inverse;
    let b = 3.0 * inverse * inverse * t;
    let c = 3.0 * inverse * t * t;
    let d = t * t * t;
    CursorPoint {
        x: a * start.x + b * control1.x + c * control2.x + d * end.x,
        y: a * start.y + b * control1.y + c * control2.y + d * end.y,
    }
}

fn ease_out_cubic(value: f64) -> f64 {
    1.0 - (1.0 - value).powi(3)
}

enum OverlayCommand {
    Move {
        point: CursorPoint,
        target_window: isize,
    },
    Pulse {
        point: CursorPoint,
        target_window: isize,
    },
    Settle {
        point: CursorPoint,
        target_window: isize,
    },
    Reset,
}

struct Motion {
    start: CursorPoint,
    end: CursorPoint,
    started_at: Instant,
}

struct OverlayState {
    current: Option<CursorPoint>,
    motion: Option<Motion>,
    target_window: isize,
    pulse_until: Option<Instant>,
    hide_at: Option<Instant>,
    visible: bool,
}

impl OverlayState {
    fn new() -> Self {
        Self {
            current: None,
            motion: None,
            target_window: 0,
            pulse_until: None,
            hide_at: None,
            visible: false,
        }
    }

    fn apply(&mut self, command: OverlayCommand, now: Instant) {
        match command {
            OverlayCommand::Move {
                point,
                target_window,
            } => {
                self.target_window = target_window;
                let start = self
                    .current
                    .unwrap_or_else(|| initial_point(target_window, point));
                self.current = Some(start);
                self.motion = Some(Motion {
                    start,
                    end: point,
                    started_at: now,
                });
                self.pulse_until = None;
                self.hide_at = Some(now + IDLE_TIMEOUT);
                self.visible = true;
            }
            OverlayCommand::Pulse {
                point,
                target_window,
            } => {
                self.target_window = target_window;
                self.current = Some(point);
                self.motion = None;
                self.pulse_until = Some(now + CLICK_DURATION);
                self.hide_at = Some(now + IDLE_TIMEOUT);
                self.visible = true;
            }
            OverlayCommand::Settle {
                point,
                target_window,
            } => {
                self.target_window = target_window;
                self.current = Some(point);
                self.motion = None;
                self.pulse_until = None;
                self.hide_at = Some(now + IDLE_TIMEOUT);
                self.visible = true;
            }
            OverlayCommand::Reset => {
                self.current = None;
                self.motion = None;
                self.target_window = 0;
                self.pulse_until = None;
                self.hide_at = None;
                self.visible = false;
            }
        }
    }

    fn tick(&mut self, now: Instant) {
        if let Some(motion) = &self.motion {
            let progress =
                now.duration_since(motion.started_at).as_secs_f64() / MOVE_DURATION.as_secs_f64();
            self.current = Some(cursor_motion_point(motion.start, motion.end, progress));
            if progress >= 1.0 {
                self.current = Some(motion.end);
                self.motion = None;
            }
        }
        if self.pulse_until.is_some_and(|deadline| now >= deadline) {
            self.pulse_until = None;
        }
        if self.hide_at.is_some_and(|deadline| now >= deadline) {
            self.hide_at = None;
            self.visible = false;
        }
    }

    fn click_progress(&self, now: Instant) -> f64 {
        self.pulse_until
            .map(|deadline| {
                let remaining = deadline.saturating_duration_since(now).as_secs_f64();
                (remaining / CLICK_DURATION.as_secs_f64()).clamp(0.0, 1.0)
            })
            .unwrap_or(0.0)
    }
}

pub fn move_visual_cursor(x: i32, y: i32, target_window: Option<HWND>) {
    send(OverlayCommand::Move {
        point: CursorPoint {
            x: f64::from(x),
            y: f64::from(y),
        },
        target_window: hwnd_value(target_window),
    });
}

pub fn pulse_visual_cursor(x: i32, y: i32, target_window: Option<HWND>) {
    send(OverlayCommand::Pulse {
        point: CursorPoint {
            x: f64::from(x),
            y: f64::from(y),
        },
        target_window: hwnd_value(target_window),
    });
}

pub fn settle_visual_cursor(x: i32, y: i32, target_window: Option<HWND>) {
    send(OverlayCommand::Settle {
        point: CursorPoint {
            x: f64::from(x),
            y: f64::from(y),
        },
        target_window: hwnd_value(target_window),
    });
}

pub fn reset_visual_cursor() {
    send(OverlayCommand::Reset);
}

fn send(command: OverlayCommand) {
    if !visual_cursor_enabled() {
        return;
    }
    let _ = overlay_sender().send(command);
}

fn visual_cursor_enabled() -> bool {
    std::env::var("LUME_COMPUTER_USE_VISUAL_CURSOR")
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(true)
}

fn overlay_sender() -> &'static mpsc::Sender<OverlayCommand> {
    static SENDER: OnceLock<mpsc::Sender<OverlayCommand>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("lume-visual-cursor".to_owned())
            .spawn(move || run_overlay(receiver))
            .ok();
        sender
    })
}

fn run_overlay(receiver: mpsc::Receiver<OverlayCommand>) {
    let Ok(hwnd) = create_overlay_window() else {
        return;
    };
    let mut state = OverlayState::new();
    loop {
        match receiver.recv_timeout(FRAME_INTERVAL) {
            Ok(command) => {
                state.apply(command, Instant::now());
                while let Ok(command) = receiver.try_recv() {
                    state.apply(command, Instant::now());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        pump_messages();
        state.tick(Instant::now());
        render_state(hwnd, &state);
    }
    unsafe {
        let _ = DestroyWindow(hwnd);
    }
}

fn create_overlay_window() -> windows::core::Result<HWND> {
    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_PAINT {
            let mut paint = PAINTSTRUCT::default();
            let dc = unsafe { BeginPaint(hwnd, &mut paint) };
            let click_progress = f64::from(CLICK_PROGRESS_MILLI.load(Ordering::Relaxed)) / 1_000.0;
            paint_cursor(dc, click_progress);
            unsafe {
                let _ = EndPaint(hwnd, &paint);
            }
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    let module = unsafe { GetModuleHandleW(None)? };
    let instance = HINSTANCE(module.0);
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: w!("LumeVisualCursorWindow"),
        ..Default::default()
    };
    unsafe {
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class.lpszClassName,
            w!("Lume Visual Cursor"),
            WS_POPUP,
            0,
            0,
            WINDOW_SIZE,
            WINDOW_SIZE,
            None,
            None,
            Some(instance),
            None,
        )?;
        SetLayeredWindowAttributes(hwnd, TRANSPARENT_KEY, 255, LWA_COLORKEY)?;
        Ok(hwnd)
    }
}

fn render_state(hwnd: HWND, state: &OverlayState) {
    if !state.visible {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        return;
    }
    let Some(point) = state.current else {
        return;
    };
    let target = hwnd_from_value(state.target_window);
    unsafe {
        let valid_target = target.filter(|item| IsWindow(Some(*item)).as_bool());
        let window_above_target = valid_target.and_then(|item| GetWindow(item, GW_HWNDPREV).ok());
        let (insert_after, flags) = if window_above_target == Some(hwnd) {
            (None, SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW)
        } else {
            (
                window_above_target.or(Some(HWND_TOP)),
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        let _ = SetWindowPos(
            hwnd,
            insert_after,
            point.x.round() as i32 - TIP_X,
            point.y.round() as i32 - TIP_Y,
            WINDOW_SIZE,
            WINDOW_SIZE,
            flags,
        );
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    draw_cursor(hwnd, state.click_progress(Instant::now()));
}

fn draw_cursor(hwnd: HWND, click_progress: f64) {
    CLICK_PROGRESS_MILLI.store(
        (click_progress.clamp(0.0, 1.0) * 1_000.0).round() as u32,
        Ordering::Relaxed,
    );
    unsafe {
        let _ = InvalidateRect(Some(hwnd), None, false);
        let _ = UpdateWindow(hwnd);
    }
}

fn paint_cursor(dc: HDC, click_progress: f64) {
    if dc.is_invalid() {
        return;
    }
    unsafe {
        let bounds = RECT {
            left: 0,
            top: 0,
            right: WINDOW_SIZE,
            bottom: WINDOW_SIZE,
        };
        let background = CreateSolidBrush(TRANSPARENT_KEY);
        FillRect(dc, &bounds, background);

        let ring = CreatePen(PS_SOLID, 3, COLORREF(0x00d8_f3a4));
        let ring_brush = CreateSolidBrush(TRANSPARENT_KEY);
        let old_pen = SelectObject(dc, HGDIOBJ::from(ring));
        let old_brush = SelectObject(dc, HGDIOBJ::from(ring_brush));
        let expansion = (click_progress * 8.0).round() as i32;
        let _ = Ellipse(
            dc,
            TIP_X - 15 - expansion,
            TIP_Y - 15 - expansion,
            TIP_X + 15 + expansion,
            TIP_Y + 15 + expansion,
        );

        let pointer_pen = CreatePen(PS_SOLID, 2, COLORREF(0x0033_544b));
        let pointer_brush = CreateSolidBrush(COLORREF(0x00b9_ffdf));
        SelectObject(dc, HGDIOBJ::from(pointer_pen));
        SelectObject(dc, HGDIOBJ::from(pointer_brush));
        let squeeze = (click_progress * 2.0).round() as i32;
        let points = [
            POINT { x: TIP_X, y: TIP_Y },
            POINT {
                x: TIP_X + 2,
                y: TIP_Y + 29 - squeeze,
            },
            POINT {
                x: TIP_X + 9,
                y: TIP_Y + 21 - squeeze,
            },
            POINT {
                x: TIP_X + 16,
                y: TIP_Y + 35 - squeeze,
            },
            POINT {
                x: TIP_X + 23,
                y: TIP_Y + 31 - squeeze,
            },
            POINT {
                x: TIP_X + 15,
                y: TIP_Y + 18 - squeeze,
            },
            POINT {
                x: TIP_X + 28,
                y: TIP_Y + 17 - squeeze,
            },
        ];
        let _ = Polygon(dc, &points);

        SelectObject(dc, old_pen);
        SelectObject(dc, old_brush);
        let _ = DeleteObject(HGDIOBJ::from(background));
        let _ = DeleteObject(HGDIOBJ::from(ring));
        let _ = DeleteObject(HGDIOBJ::from(ring_brush));
        let _ = DeleteObject(HGDIOBJ::from(pointer_pen));
        let _ = DeleteObject(HGDIOBJ::from(pointer_brush));
    }
}

fn pump_messages() {
    unsafe {
        let mut message = MSG::default();
        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

fn initial_point(target_window: isize, fallback: CursorPoint) -> CursorPoint {
    let Some(hwnd) = hwnd_from_value(target_window) else {
        return fallback;
    };
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return fallback;
    }
    CursorPoint {
        x: f64::from(rect.left + 48),
        y: f64::from(rect.bottom - 48),
    }
}

fn hwnd_value(hwnd: Option<HWND>) -> isize {
    hwnd.map(|value| value.0 as isize).unwrap_or_default()
}

fn hwnd_from_value(value: isize) -> Option<HWND> {
    (value != 0).then_some(HWND(value as *mut c_void))
}
