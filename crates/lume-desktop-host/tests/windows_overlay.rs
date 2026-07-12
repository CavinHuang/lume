#![cfg(windows)]

use lume_desktop_host::{
    windows_cursor_glyph::{cursor_physical_size_for_dpi, render_reference_cursor_frame_at_size},
    windows_cursor_motion::{
        cursor_motion_frame_points, spring_close_enough_time_seconds, CursorBounds, CursorMotion,
        CursorPoint, CursorVector,
    },
    windows_overlay::{cursor_reference_metrics, cursor_window_metrics},
};

#[test]
fn cursor_window_matches_the_reference_glyph_geometry() {
    assert_eq!(cursor_window_metrics(), ((126, 126), (60, 70)));
    assert_eq!(cursor_reference_metrics(), (252, 252, 252 * 252 * 4));
}

#[test]
fn reference_glyph_renders_transparent_rotatable_bgra_frames() {
    let neutral = render_reference_cursor_frame_at_size(126, 0.0, 0.0);
    let rotated = render_reference_cursor_frame_at_size(126, 0.45, 0.0);
    let clicked = render_reference_cursor_frame_at_size(126, 0.0, 1.0);
    let high_dpi = render_reference_cursor_frame_at_size(252, 0.0, 0.0);

    assert_eq!(neutral.len(), 126 * 126 * 4);
    assert_eq!(high_dpi.len(), 252 * 252 * 4);
    assert_eq!(neutral[3], 0);
    assert!(neutral[((63 * 126 + 63) * 4) + 3] > 0);
    assert_ne!(neutral, rotated);
    assert_ne!(neutral, clicked);
}

#[test]
fn cursor_window_scales_with_the_target_monitor_dpi() {
    assert_eq!(cursor_physical_size_for_dpi(96), 126);
    assert_eq!(cursor_physical_size_for_dpi(144), 189);
    assert_eq!(cursor_physical_size_for_dpi(192), 252);
}

#[test]
fn cursor_motion_starts_and_ends_at_exact_points() {
    let start = CursorPoint { x: 100.0, y: 700.0 };
    let end = CursorPoint { x: 900.0, y: 220.0 };
    let motion = CursorMotion::new(
        start,
        end,
        CursorBounds::new(0.0, 0.0, 1280.0, 800.0),
        CursorVector::new(1.0, 0.0),
        CursorVector::new(-1.0, -1.0),
    );

    assert_eq!(motion.point_at_elapsed(0.0), start);
    assert_ne!(
        motion.point_at_elapsed(spring_close_enough_time_seconds() - (1.0 / 240.0)),
        end
    );
    assert_eq!(
        motion.point_at_elapsed(spring_close_enough_time_seconds()),
        end
    );
}

#[test]
fn aligned_headings_choose_the_near_direct_reference_path() {
    let start = CursorPoint { x: 120.0, y: 120.0 };
    let end = CursorPoint { x: 920.0, y: 320.0 };
    let direction = CursorVector::between(start, end).normalized();
    let motion = CursorMotion::new(
        start,
        end,
        CursorBounds::new(0.0, 0.0, 1280.0, 800.0),
        direction,
        direction,
    );
    let direct_distance = CursorVector::between(start, end).length();

    assert_eq!(motion.side(), 0);
    assert!(motion.total_turn() < 0.45);
    assert!(motion.path_length() < direct_distance * 1.03);
}

#[test]
fn opposite_start_heading_chooses_a_turnaround_reference_path() {
    let start = CursorPoint { x: 220.0, y: 520.0 };
    let end = CursorPoint { x: 900.0, y: 280.0 };
    let bounds = CursorBounds::new(0.0, 0.0, 1280.0, 800.0);
    let direction = CursorVector::between(start, end).normalized();
    let direct = CursorMotion::new(start, end, bounds, direction, direction);
    let turnaround = CursorMotion::new(start, end, bounds, direction.scaled(-1.0), direction);

    assert_ne!(turnaround.side(), 0);
    assert!(turnaround.total_turn() > direct.total_turn() + 0.8);
    assert!(turnaround.path_length() > direct.path_length() * 1.04);
}

#[test]
fn spring_timing_matches_the_recovered_reference() {
    let actual = spring_close_enough_time_seconds();
    assert!(
        (actual - 1.429_166_666_666_663).abs() < 0.000_001,
        "unexpected spring close-enough time: {actual}"
    );
}

#[test]
fn physical_pointer_frames_use_the_same_reference_motion() {
    let start = CursorPoint { x: 50.0, y: 650.0 };
    let end = CursorPoint { x: 950.0, y: 180.0 };
    let frames = cursor_motion_frame_points(
        start,
        end,
        CursorBounds::new(0.0, 0.0, 1280.0, 800.0),
        CursorVector::new(-1.0, -1.0).normalized(),
        CursorVector::new(-1.0, -1.0).normalized(),
        1.0 / 60.0,
    );

    assert!(frames.len() >= 85);
    assert_eq!(frames.last(), Some(&end));
    assert_ne!(frames[frames.len() / 2], CursorPoint { x: 500.0, y: 415.0 });
}
