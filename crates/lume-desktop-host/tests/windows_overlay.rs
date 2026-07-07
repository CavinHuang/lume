#![cfg(windows)]

use lume_desktop_host::windows_overlay::{cursor_motion_point, CursorPoint};

#[test]
fn cursor_motion_starts_and_ends_at_exact_points() {
    let start = CursorPoint { x: 100.0, y: 700.0 };
    let end = CursorPoint { x: 900.0, y: 220.0 };

    assert_eq!(cursor_motion_point(start, end, 0.0), start);
    assert_eq!(cursor_motion_point(start, end, 1.0), end);
}

#[test]
fn cursor_motion_uses_a_curved_path_instead_of_linear_interpolation() {
    let start = CursorPoint { x: 100.0, y: 700.0 };
    let end = CursorPoint { x: 900.0, y: 220.0 };
    let midpoint = cursor_motion_point(start, end, 0.5);
    let linear_midpoint = CursorPoint { x: 500.0, y: 460.0 };

    assert_ne!(midpoint, linear_midpoint);
    assert!(midpoint.x > start.x && midpoint.x < end.x);
    assert!(midpoint.y > end.y && midpoint.y < start.y);
}

#[test]
fn cursor_motion_clamps_out_of_range_progress() {
    let start = CursorPoint { x: 20.0, y: 30.0 };
    let end = CursorPoint { x: 400.0, y: 500.0 };

    assert_eq!(cursor_motion_point(start, end, -1.0), start);
    assert_eq!(cursor_motion_point(start, end, 2.0), end);
}
