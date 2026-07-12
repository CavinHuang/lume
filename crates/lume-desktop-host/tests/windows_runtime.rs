#![cfg(windows)]

use lume_desktop_host::initialize_windows_runtime;
use windows::Win32::UI::HiDpi::{
    GetAwarenessFromDpiAwarenessContext, GetThreadDpiAwarenessContext,
    DPI_AWARENESS_PER_MONITOR_AWARE,
};

#[test]
fn initializes_per_monitor_dpi_awareness_for_coordinate_alignment() {
    initialize_windows_runtime().unwrap();

    let awareness = unsafe { GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) };
    assert_eq!(awareness, DPI_AWARENESS_PER_MONITOR_AWARE);
}
