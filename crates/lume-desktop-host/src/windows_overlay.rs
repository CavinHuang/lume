use std::{
    ffi::c_void,
    mem::size_of,
    ptr::copy_nonoverlapping,
    sync::{mpsc, OnceLock},
    thread,
    time::{Duration, Instant},
};

use crate::{
    windows_cursor_glyph::{cursor_physical_size_for_dpi, render_reference_cursor_frame_at_size},
    windows_cursor_motion::{
        spring_close_enough_time_seconds, CursorBounds, CursorMotion, CursorPoint, CursorVector,
    },
};
use windows::{
    core::w,
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM},
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
            AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION,
            DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetSystemMetrics,
                GetWindow, IsWindow, PeekMessageW, RegisterClassW, SetWindowPos, ShowWindow,
                TranslateMessage, UpdateLayeredWindow, GW_HWNDPREV, HWND_TOP, MSG, PM_REMOVE,
                SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
                SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, ULW_ALPHA, WNDCLASSW,
                WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
            },
        },
    },
};

const WINDOW_SIZE: i32 = 126;
const TIP_X: i32 = 60;
const TIP_Y: i32 = 70;
const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const CLICK_DURATION: Duration = Duration::from_millis(220);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const NEUTRAL_HEADING: f64 = -3.0 * std::f64::consts::PI / 4.0;
pub(crate) const VISUAL_CURSOR_WINDOW_TITLE: &str = "Lume Visual Cursor";

pub fn cursor_window_metrics() -> ((i32, i32), (i32, i32)) {
    ((WINDOW_SIZE, WINDOW_SIZE), (TIP_X, TIP_Y))
}

pub fn cursor_reference_metrics() -> (usize, usize, usize) {
    crate::windows_cursor_glyph::reference_cursor_metrics()
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
    path: CursorMotion,
    started_at: Instant,
}

struct OverlayState {
    current: Option<CursorPoint>,
    motion: Option<Motion>,
    target_window: isize,
    pulse_until: Option<Instant>,
    hide_at: Option<Instant>,
    forward: CursorVector,
    rotation: f64,
    idle_started_at: Option<Instant>,
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
            forward: resting_forward(),
            rotation: 0.0,
            idle_started_at: None,
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
                let start = self.current.unwrap_or_else(default_initial_point);
                self.current = Some(start);
                self.motion = Some(Motion {
                    path: CursorMotion::new(
                        start,
                        point,
                        motion_bounds(start, point),
                        self.forward,
                        resting_forward(),
                    ),
                    started_at: now,
                });
                self.pulse_until = None;
                self.hide_at = Some(now + IDLE_TIMEOUT);
                self.idle_started_at = None;
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
                self.forward = resting_forward();
                self.rotation = 0.0;
                self.idle_started_at = None;
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
                self.forward = resting_forward();
                self.rotation = 0.0;
                self.idle_started_at = Some(now);
                self.visible = true;
            }
            OverlayCommand::Reset => {
                self.current = None;
                self.motion = None;
                self.target_window = 0;
                self.pulse_until = None;
                self.hide_at = None;
                self.forward = resting_forward();
                self.rotation = 0.0;
                self.idle_started_at = None;
                self.visible = false;
            }
        }
    }

    fn tick(&mut self, now: Instant) {
        if let Some(motion) = &self.motion {
            let elapsed = now.duration_since(motion.started_at).as_secs_f64();
            self.current = Some(motion.path.point_at_elapsed(elapsed));
            self.forward = motion.path.tangent_at_elapsed(elapsed);
            self.rotation = normalize_angle(self.forward.y.atan2(self.forward.x) - NEUTRAL_HEADING);
            if elapsed >= spring_close_enough_time_seconds() {
                self.current = Some(
                    motion
                        .path
                        .point_at_elapsed(spring_close_enough_time_seconds()),
                );
                self.motion = None;
                self.forward = resting_forward();
                self.rotation = 0.0;
                self.idle_started_at = Some(now);
            }
        }
        if self.pulse_until.is_some_and(|deadline| now >= deadline) {
            self.pulse_until = None;
            self.idle_started_at = Some(now);
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
                let elapsed = 1.0 - (remaining / CLICK_DURATION.as_secs_f64()).clamp(0.0, 1.0);
                (elapsed * std::f64::consts::PI).sin()
            })
            .unwrap_or(0.0)
    }

    fn render_rotation(&self, now: Instant) -> f64 {
        let idle_wobble = self
            .idle_started_at
            .map(|started_at| (now.duration_since(started_at).as_secs_f64() * 2.4).sin() * 0.09)
            .unwrap_or(0.0);
        normalize_angle(self.rotation + idle_wobble)
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
    let Ok(mut surface) = LayeredCursorSurface::new(WINDOW_SIZE) else {
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
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
        render_state(hwnd, &mut surface, &state);
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
        CreateWindowExW(
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
        )
    }
}

struct LayeredCursorSurface {
    dc: HDC,
    bitmap: HBITMAP,
    previous_object: HGDIOBJ,
    bits: *mut u8,
    size: i32,
}

impl LayeredCursorSurface {
    fn new(size: i32) -> windows::core::Result<Self> {
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return Err(windows::core::Error::from_win32());
            }
            let mut bitmap_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size,
                    biHeight: -size,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(
                Some(dc),
                &raw mut bitmap_info,
                DIB_RGB_COLORS,
                &mut bits,
                None,
                0,
            ) {
                Ok(bitmap) => bitmap,
                Err(error) => {
                    let _ = DeleteDC(dc);
                    return Err(error);
                }
            };
            if bits.is_null() {
                let _ = DeleteObject(HGDIOBJ::from(bitmap));
                let _ = DeleteDC(dc);
                return Err(windows::core::Error::from_win32());
            }
            let previous_object = SelectObject(dc, HGDIOBJ::from(bitmap));
            Ok(Self {
                dc,
                bitmap,
                previous_object,
                bits: bits.cast(),
                size,
            })
        }
    }

    fn ensure_size(&mut self, size: i32) -> windows::core::Result<()> {
        if self.size != size {
            *self = Self::new(size)?;
        }
        Ok(())
    }

    fn draw(
        &mut self,
        hwnd: HWND,
        point: CursorPoint,
        rotation: f64,
        click_progress: f64,
    ) -> windows::core::Result<()> {
        let frame =
            render_reference_cursor_frame_at_size(self.size as usize, rotation, click_progress);
        unsafe {
            copy_nonoverlapping(frame.as_ptr(), self.bits, frame.len());
            let scale = f64::from(self.size) / f64::from(WINDOW_SIZE);
            let destination = POINT {
                x: (point.x - f64::from(TIP_X) * scale).round() as i32,
                y: (point.y - f64::from(TIP_Y) * scale).round() as i32,
            };
            let size = SIZE {
                cx: self.size,
                cy: self.size,
            };
            let source = POINT { x: 0, y: 0 };
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            UpdateLayeredWindow(
                hwnd,
                None,
                Some(&raw const destination),
                Some(&raw const size),
                Some(self.dc),
                Some(&raw const source),
                COLORREF(0),
                Some(&raw const blend),
                ULW_ALPHA,
            )
        }
    }
}

impl Drop for LayeredCursorSurface {
    fn drop(&mut self) {
        unsafe {
            let _ = SelectObject(self.dc, self.previous_object);
            let _ = DeleteObject(HGDIOBJ::from(self.bitmap));
            let _ = DeleteDC(self.dc);
        }
    }
}

fn render_state(hwnd: HWND, surface: &mut LayeredCursorSurface, state: &OverlayState) {
    if !state.visible {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        return;
    }
    let Some(point) = state.current else {
        return;
    };
    let now = Instant::now();
    let target = hwnd_from_value(state.target_window);
    let valid_target = unsafe { target.filter(|item| IsWindow(Some(*item)).as_bool()) };
    let dpi = unsafe { GetDpiForWindow(valid_target.unwrap_or(hwnd)) };
    let cursor_size = cursor_physical_size_for_dpi(dpi) as i32;
    if surface.ensure_size(cursor_size).is_err() {
        return;
    }
    let scale = f64::from(cursor_size) / f64::from(WINDOW_SIZE);
    unsafe {
        let window_above_target = valid_target.and_then(|item| GetWindow(item, GW_HWNDPREV).ok());
        let (insert_after, flags) = if window_above_target == Some(hwnd) {
            (None, SWP_NOACTIVATE | SWP_NOZORDER)
        } else {
            (window_above_target.or(Some(HWND_TOP)), SWP_NOACTIVATE)
        };
        let _ = SetWindowPos(
            hwnd,
            insert_after,
            (point.x - f64::from(TIP_X) * scale).round() as i32,
            (point.y - f64::from(TIP_Y) * scale).round() as i32,
            cursor_size,
            cursor_size,
            flags,
        );
    }
    if surface
        .draw(
            hwnd,
            point,
            state.render_rotation(now),
            state.click_progress(now),
        )
        .is_ok()
    {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
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

fn default_initial_point() -> CursorPoint {
    CursorPoint {
        x: f64::from(TIP_X),
        y: f64::from(TIP_Y),
    }
}

fn motion_bounds(start: CursorPoint, end: CursorPoint) -> CursorBounds {
    let virtual_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let virtual_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let virtual_width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let virtual_height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if virtual_width > 0 && virtual_height > 0 {
        return CursorBounds::new(
            f64::from(virtual_x),
            f64::from(virtual_y),
            f64::from(virtual_width),
            f64::from(virtual_height),
        );
    }
    CursorBounds::new(
        start.x.min(end.x) - 200.0,
        start.y.min(end.y) - 200.0,
        (start.x - end.x).abs() + 400.0,
        (start.y - end.y).abs() + 400.0,
    )
}

fn resting_forward() -> CursorVector {
    CursorVector::new(NEUTRAL_HEADING.cos(), NEUTRAL_HEADING.sin())
}

fn normalize_angle(mut angle: f64) -> f64 {
    while angle > std::f64::consts::PI {
        angle -= 2.0 * std::f64::consts::PI;
    }
    while angle < -std::f64::consts::PI {
        angle += 2.0 * std::f64::consts::PI;
    }
    angle
}

fn hwnd_value(hwnd: Option<HWND>) -> isize {
    hwnd.map(|value| value.0 as isize).unwrap_or_default()
}

fn hwnd_from_value(value: isize) -> Option<HWND> {
    (value != 0).then_some(HWND(value as *mut c_void))
}
