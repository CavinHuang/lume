use lume_desktop_host::macos_snapshot::{
    find_macos_window, first_visible_user_window, macos_current_context_result,
    macos_get_window_result, macos_get_window_state_result,
    macos_get_window_state_result_with_related, macos_global_pointer_fallback_enabled_from,
    macos_key_chord, macos_list_apps_result, macos_list_apps_result_with_discovered,
    macos_list_windows_result, macos_matching_secondary_action, macos_non_sensitive_selected_text,
    macos_pointer_input_mode, macos_preferred_click_actions, macos_related_transient_windows,
    macos_resolve_action_point, macos_set_value_attribute_is_settable,
    macos_text_target_is_sensitive, macos_visible_pointer_enabled_from, macos_visible_pointer_mode,
    macos_visible_pointer_motion_points, macos_wait_for_state_result, MacOSDiscoveredApp,
    MacOSElementInfo, MacOSWindowInfo, MACOS_NON_SETTABLE_SET_VALUE_ERROR,
};
use serde_json::json;

fn sample_windows() -> Vec<MacOSWindowInfo> {
    vec![
        MacOSWindowInfo {
            window_id: 42,
            owner_pid: 1001,
            bundle_identifier: None,
            owner_name: "微信".into(),
            title: "项目群".into(),
            x: 10.0,
            y: 20.0,
            width: 900.0,
            height: 700.0,
            layer: 0,
            is_onscreen: true,
            is_focused: true,
            document_text: None,
            selected_text: None,
            screenshot_data_url: None,
            screenshot_error: None,
            accessibility_truncated: false,
            elements: vec![],
        },
        MacOSWindowInfo {
            window_id: 77,
            owner_pid: 1002,
            bundle_identifier: None,
            owner_name: "TextEdit".into(),
            title: "周报.rtf".into(),
            x: 200.0,
            y: 80.0,
            width: 640.0,
            height: 480.0,
            layer: 0,
            is_onscreen: true,
            is_focused: false,
            document_text: None,
            selected_text: None,
            screenshot_data_url: None,
            screenshot_error: None,
            accessibility_truncated: false,
            elements: vec![],
        },
        MacOSWindowInfo {
            window_id: 99,
            owner_pid: 1003,
            bundle_identifier: None,
            owner_name: "Dock".into(),
            title: "Dock".into(),
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 80.0,
            layer: 25,
            is_onscreen: true,
            is_focused: false,
            document_text: None,
            selected_text: None,
            screenshot_data_url: None,
            screenshot_error: None,
            accessibility_truncated: false,
            elements: vec![],
        },
    ]
}

#[test]
fn maps_core_graphics_windows_to_lume_window_refs() {
    let result = macos_list_windows_result(&sample_windows(), None);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["windows"].as_array().unwrap().len(), 2);
    assert_eq!(result["windows"][0]["id"], "macos:42");
    assert_eq!(result["windows"][0]["appId"], "pid:1001");
    assert_eq!(result["windows"][0]["appName"], "微信");
    assert_eq!(result["windows"][0]["title"], "项目群");
    assert_eq!(result["windows"][0]["focused"], true);
    assert_eq!(
        result["windows"][0]["bounds"],
        json!({ "x": 10, "y": 20, "width": 900, "height": 700 })
    );
}

#[test]
fn maps_unique_apps_from_visible_macos_windows() {
    let result = macos_list_apps_result(&sample_windows());

    assert_eq!(result["status"], "ok");
    assert_eq!(result["apps"].as_array().unwrap().len(), 2);
    assert_eq!(result["apps"][0]["id"], "pid:1001");
    assert_eq!(result["apps"][0]["name"], "微信");
    assert_eq!(result["apps"][0]["displayName"], "微信");
    assert_eq!(result["apps"][0]["isRunning"], true);
    assert_eq!(result["apps"][0]["processId"], 1001);
    assert_eq!(result["apps"][0]["windows"][0]["id"], "macos:42");
}

#[test]
fn merges_recent_installed_apps_with_running_macos_windows() {
    let mut windows = sample_windows();
    windows[0].bundle_identifier = Some("com.tencent.xinWeChat".into());
    let discovered = vec![
        MacOSDiscoveredApp {
            id: "com.tencent.xinWeChat".into(),
            name: "WeChat".into(),
            path: "/Applications/WeChat.app".into(),
            is_running: true,
            is_frontmost: true,
            last_used_at: Some(1_700_000_000_000),
            usage_count: Some(20),
        },
        MacOSDiscoveredApp {
            id: "com.apple.TextEdit".into(),
            name: "TextEdit".into(),
            path: "/System/Applications/TextEdit.app".into(),
            is_running: false,
            is_frontmost: false,
            last_used_at: Some(1_699_000_000_000),
            usage_count: Some(8),
        },
    ];

    let result = macos_list_apps_result_with_discovered(&windows, &discovered);
    let apps = result["apps"].as_array().unwrap();

    assert_eq!(apps.len(), 3);
    assert_eq!(apps[0]["id"], "com.tencent.xinWeChat");
    assert_eq!(apps[0]["name"], "微信");
    assert_eq!(apps[0]["isFrontmost"], true);
    assert_eq!(apps[0]["windows"][0]["id"], "macos:42");
    assert_eq!(apps[1]["id"], "pid:1002");
    assert_eq!(apps[2]["id"], "com.apple.TextEdit");
    assert_eq!(apps[2]["isRunning"], false);
    assert_eq!(apps[2]["path"], "/System/Applications/TextEdit.app");
    assert_eq!(apps[2]["windows"], json!([]));
}

#[test]
fn groups_multiple_visible_windows_under_their_app() {
    let mut windows = sample_windows();
    let mut second_wechat_window = windows[0].clone();
    second_wechat_window.window_id = 43;
    second_wechat_window.title = "产品群".into();
    second_wechat_window.is_focused = false;
    windows.insert(1, second_wechat_window);

    let result = macos_list_apps_result(&windows);

    assert_eq!(result["apps"][0]["windows"].as_array().unwrap().len(), 2);
    assert_eq!(result["apps"][0]["windows"][1]["id"], "macos:43");
}

#[test]
fn prefers_stable_macos_bundle_identifier_for_app_identity() {
    let mut windows = sample_windows();
    windows[0].bundle_identifier = Some("com.tencent.xinWeChat".into());

    let apps = macos_list_apps_result(&windows);
    let context = macos_current_context_result(&windows[0], false);
    let state = macos_get_window_state_result(&windows[0], false);

    assert_eq!(apps["apps"][0]["id"], "com.tencent.xinWeChat");
    assert_eq!(apps["apps"][0]["platformId"], "1001");
    assert_eq!(context["snapshot"]["app"]["id"], "com.tencent.xinWeChat");
    assert_eq!(
        context["snapshot"]["window"]["appId"],
        "com.tencent.xinWeChat"
    );
    assert_eq!(state["window"]["appId"], "com.tencent.xinWeChat");
}

#[test]
fn maps_single_macos_window_to_window_ref() {
    let result = macos_get_window_result(find_macos_window(&sample_windows(), "macos:42"));

    assert_eq!(result["status"], "ok");
    assert_eq!(result["window"]["id"], "macos:42");
    assert_eq!(result["window"]["appId"], "pid:1001");
    assert_eq!(result["window"]["appName"], "微信");
    assert_eq!(result["window"]["title"], "项目群");
    assert_eq!(
        result["window"]["bounds"],
        json!({ "x": 10, "y": 20, "width": 900, "height": 700 })
    );
}

#[test]
fn reports_stale_target_for_missing_macos_window_ref() {
    let result = macos_get_window_result(find_macos_window(&sample_windows(), "macos:404"));

    assert_eq!(result["status"], "stale_target");
    assert_eq!(result["message"], "target window is unavailable");
}

#[test]
fn foreground_window_selection_prefers_the_focused_window() {
    let mut windows = sample_windows();
    windows[0].is_focused = false;
    windows[1].is_focused = true;

    let selected = first_visible_user_window(&windows).expect("foreground window");

    assert_eq!(selected.window_id, 77);
}

#[test]
fn maps_frontmost_window_to_context_snapshot_without_screenshot_pixels() {
    let window = &sample_windows()[0];
    let result = macos_current_context_result(window, false);

    assert_eq!(result["status"], "ok");
    assert_eq!(
        result["snapshot"]["app"],
        json!({ "id": "pid:1001", "name": "微信", "processId": 1001 })
    );
    assert_eq!(result["snapshot"]["window"]["id"], "macos:42");
    assert_eq!(result["snapshot"]["visibleText"], "项目群");
    assert_eq!(result["snapshot"]["untrusted"], true);
    assert!(result["snapshot"]["screenshots"][0]
        .get("dataUrl")
        .is_none());
}

#[test]
fn maps_window_state_with_stable_revision_and_accessibility_fallback() {
    let window = &sample_windows()[1];
    let result = macos_get_window_state_result(window, true);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["window"]["id"], "macos:77");
    assert_eq!(result["revision"], "macos:77:周报.rtf:200:80:640:480");
    assert_eq!(result["accessibility"]["documentText"], "周报.rtf");
    assert_eq!(result["screenshots"][0]["mimeType"], "image/png");
    assert!(result["screenshots"][0].get("dataUrl").is_none());
}

#[test]
fn includes_macos_screenshot_pixels_only_when_requested() {
    let mut window = sample_windows()[0].clone();
    window.screenshot_data_url = Some("data:image/png;base64,iVBORw0KGgo=".into());

    let without_pixels = macos_get_window_state_result(&window, false);
    let with_pixels = macos_get_window_state_result(&window, true);
    let context = macos_current_context_result(&window, true);

    assert!(without_pixels["screenshots"][0].get("dataUrl").is_none());
    assert_eq!(
        with_pixels["screenshots"][0]["dataUrl"],
        "data:image/png;base64,iVBORw0KGgo="
    );
    assert_eq!(
        context["snapshot"]["screenshots"][0]["dataUrl"],
        "data:image/png;base64,iVBORw0KGgo="
    );
}

#[test]
fn includes_macos_screenshot_error_only_when_pixels_are_requested() {
    let mut window = sample_windows()[0].clone();
    window.screenshot_error = Some("window capture returned null".into());

    let without_pixels = macos_get_window_state_result(&window, false);
    let with_pixels = macos_get_window_state_result(&window, true);

    assert!(without_pixels["screenshots"][0].get("error").is_none());
    assert_eq!(
        with_pixels["screenshots"][0]["error"],
        "window capture returned null"
    );
}

#[test]
fn includes_overlapping_frontmost_app_windows_as_bounded_screenshots() {
    let target = sample_windows()[0].clone();
    let mut popup = target.clone();
    popup.window_id = 44;
    popup.title = String::new();
    popup.x = 240.0;
    popup.y = 160.0;
    popup.width = 320.0;
    popup.height = 240.0;
    popup.layer = 3;
    popup.is_focused = false;
    popup.screenshot_data_url = Some("data:image/png;base64,iVBORw0KGgo=".into());
    let windows = vec![popup, target.clone()];

    let related = macos_related_transient_windows(&windows, &target, 2);
    let state = macos_get_window_state_result_with_related(&target, &related, true);

    assert_eq!(related.len(), 1);
    assert_eq!(related[0].window_id, 44);
    assert_eq!(state["screenshots"].as_array().unwrap().len(), 2);
    assert!(state["screenshots"][0]["id"]
        .as_str()
        .unwrap()
        .contains("macos:42"));
    assert!(state["screenshots"][1]["id"]
        .as_str()
        .unwrap()
        .contains("macos:44"));
    assert_eq!(state["screenshots"][0]["zIndex"], 0);
    assert_eq!(state["screenshots"][1]["zIndex"], 1);
    assert_eq!(
        state["screenshots"][1]["origin"],
        json!({ "x": 240, "y": 160 })
    );
}

#[test]
fn excludes_background_non_overlapping_and_other_app_windows_from_related_screenshots() {
    let target = sample_windows()[0].clone();
    let mut background = target.clone();
    background.window_id = 45;
    let mut non_overlapping = target.clone();
    non_overlapping.window_id = 46;
    non_overlapping.x = 2_000.0;
    let mut other_app = target.clone();
    other_app.window_id = 47;
    other_app.owner_pid = 9999;
    let windows = vec![non_overlapping, other_app, target.clone(), background];

    assert!(macos_related_transient_windows(&windows, &target, 2).is_empty());
}

#[test]
fn does_not_resolve_unknown_macos_window_ids() {
    assert_eq!(find_macos_window(&sample_windows(), "macos:404"), None);
    assert_eq!(find_macos_window(&sample_windows(), "win:42"), None);
}

#[test]
fn prefers_accessibility_text_for_context_and_window_state() {
    let mut window = sample_windows()[0].clone();
    window.document_text = Some("A: 这个 PR 今天能发吗？\nB: 我看完测试后回复".into());
    window.selected_text = Some("这个 PR 今天能发吗？".into());

    let context = macos_current_context_result(&window, false);
    let state = macos_get_window_state_result(&window, false);

    assert_eq!(
        context["snapshot"]["visibleText"],
        "A: 这个 PR 今天能发吗？\nB: 我看完测试后回复"
    );
    assert_eq!(context["snapshot"]["selectedText"], "这个 PR 今天能发吗？");
    assert_eq!(
        state["accessibility"]["documentText"],
        "A: 这个 PR 今天能发吗？\nB: 我看完测试后回复"
    );
    assert_eq!(
        state["accessibility"]["selectedText"],
        "这个 PR 今天能发吗？"
    );
}

#[test]
fn maps_accessibility_elements_to_stable_tree_nodes() {
    let mut window = sample_windows()[0].clone();
    window.elements = vec![
        MacOSElementInfo {
            role: "AXTextArea".into(),
            title: "聊天记录".into(),
            value: "A: 这个 PR 今天能发吗？".into(),
            x: 30.0,
            y: 80.0,
            width: 500.0,
            height: 300.0,
            enabled: true,
            focused: false,
            sensitive: false,
            settable: true,
            actions: vec!["AXPress".into(), "AXShowMenu".into()],
            children: vec![],
        },
        MacOSElementInfo {
            role: "AXTextField".into(),
            title: "密码".into(),
            value: "secret-token".into(),
            x: 30.0,
            y: 420.0,
            width: 500.0,
            height: 44.0,
            enabled: true,
            focused: true,
            sensitive: true,
            settable: true,
            actions: vec![],
            children: vec![],
        },
    ];

    let state = macos_get_window_state_result(&window, false);

    assert_eq!(state["accessibility"]["tree"][0]["id"], "root.0");
    assert_eq!(state["accessibility"]["tree"][0]["role"], "text_area");
    assert_eq!(state["accessibility"]["tree"][0]["name"], "聊天记录");
    assert_eq!(
        state["accessibility"]["tree"][0]["value"],
        "A: 这个 PR 今天能发吗？"
    );
    assert_eq!(state["accessibility"]["tree"][0]["settable"], true);
    assert_eq!(
        state["accessibility"]["tree"][0]["actions"],
        json!(["AXPress", "AXShowMenu"])
    );
    assert_eq!(state["accessibility"]["tree"][1]["id"], "root.1");
    assert_eq!(state["accessibility"]["tree"][1]["role"], "text_field");
    assert_eq!(state["accessibility"]["tree"][1]["sensitive"], true);
    assert_eq!(state["accessibility"]["tree"][1]["settable"], true);
    assert!(state["accessibility"]["tree"][1].get("value").is_none());
    assert_eq!(state["accessibility"]["focusedElement"]["id"], "root.1");
    let document_text = state["accessibility"]["documentText"].as_str().unwrap();
    assert!(document_text.contains("聊天记录"));
    assert!(document_text.contains("A: 这个 PR 今天能发吗？"));
    assert!(!document_text.contains("secret-token"));
}

#[test]
fn matches_macos_secondary_actions_case_insensitively() {
    let actions = vec!["AXPress".to_owned(), "AXShowMenu".to_owned()];

    assert_eq!(
        macos_matching_secondary_action(&actions, "axshowmenu"),
        Some("AXShowMenu")
    );
    assert_eq!(macos_matching_secondary_action(&actions, "AXRaise"), None);
}

#[test]
fn waits_for_matching_macos_window_state_predicates() {
    let mut window = sample_windows()[0].clone();
    window.document_text = Some("项目群\nA: 今天可以发版吗？".into());

    let result = macos_wait_for_state_result(
        Some(window),
        &json!({
            "titleContains": "发版",
            "focused": true,
            "revisionNot": "macos:42:old:10:20:900:700",
            "includeScreenshot": false,
        }),
    );

    assert_eq!(result["status"], "ok");
    assert_eq!(result["window"]["id"], "macos:42");
    assert_eq!(result["window"]["focused"], true);
    assert_eq!(
        result["accessibility"]["documentText"],
        "项目群\nA: 今天可以发版吗？"
    );
    assert_ne!(result["revision"], "macos:42:old:10:20:900:700");
}

#[test]
fn returns_timeout_when_macos_window_state_predicates_do_not_match() {
    let result = macos_wait_for_state_result(
        Some(sample_windows()[1].clone()),
        &json!({
            "titleContains": "项目群",
            "focused": true,
            "revisionNot": "macos:77:周报.rtf:200:80:640:480",
        }),
    );

    assert_eq!(result["status"], "timeout");
    assert_eq!(
        result["message"],
        "desktop window state did not match before timeout"
    );
}

#[test]
fn returns_stale_target_when_waiting_for_missing_macos_window() {
    let result = macos_wait_for_state_result(None, &json!({ "titleContains": "项目群" }));

    assert_eq!(result["status"], "stale_target");
    assert_eq!(result["message"], "target window is unavailable");
}

#[test]
fn resolves_macos_action_points_from_nested_element_ids() {
    let mut window = sample_windows()[0].clone();
    window.elements = vec![MacOSElementInfo {
        role: "AXGroup".into(),
        title: "消息区".into(),
        value: String::new(),
        x: 20.0,
        y: 40.0,
        width: 400.0,
        height: 300.0,
        enabled: true,
        focused: false,
        sensitive: false,
        settable: false,
        actions: vec![],
        children: vec![MacOSElementInfo {
            role: "AXButton".into(),
            title: "发送".into(),
            value: String::new(),
            x: 420.0,
            y: 520.0,
            width: 80.0,
            height: 40.0,
            enabled: true,
            focused: false,
            sensitive: false,
            settable: false,
            actions: vec![],
            children: vec![],
        }],
    }];

    assert_eq!(
        macos_resolve_action_point(&window, &json!({ "elementId": "root.0.0" })).unwrap(),
        (460, 540)
    );
    assert_eq!(
        macos_resolve_action_point(&window, &json!({ "x": 12, "y": 34 })).unwrap(),
        (12, 34)
    );
}

#[test]
fn reports_stale_target_for_unknown_macos_action_element_ids() {
    let result =
        macos_resolve_action_point(&sample_windows()[0], &json!({ "elementId": "root.9" }))
            .unwrap_err();

    assert_eq!(result["status"], "stale_target");
    assert_eq!(result["message"], "target element is unavailable");
}

#[test]
fn rejects_macos_action_points_without_coordinates_or_element_id() {
    let result = macos_resolve_action_point(&sample_windows()[0], &json!({})).unwrap_err();

    assert_eq!(result["status"], "failed");
    assert_eq!(result["message"], "x/y or elementId is required");
}

#[test]
fn detects_sensitive_macos_text_targets_before_typing() {
    let mut window = sample_windows()[0].clone();
    window.elements = vec![MacOSElementInfo {
        role: "AXSecureTextField".into(),
        title: "密码".into(),
        value: "secret".into(),
        x: 30.0,
        y: 420.0,
        width: 500.0,
        height: 44.0,
        enabled: true,
        focused: true,
        sensitive: true,
        settable: true,
        actions: vec![],
        children: vec![],
    }];

    assert!(macos_text_target_is_sensitive(
        &window,
        &json!({ "elementId": "root.0" })
    ));
    assert!(macos_text_target_is_sensitive(&window, &json!({})));
    assert!(!macos_text_target_is_sensitive(
        &sample_windows()[0],
        &json!({ "elementId": "root.0" })
    ));
}

#[test]
fn never_exposes_selected_text_from_sensitive_macos_elements() {
    assert_eq!(
        macos_non_sensitive_selected_text(true, Some("123456".into())),
        None
    );
    assert_eq!(
        macos_non_sensitive_selected_text(false, Some("项目周报".into())),
        Some("项目周报".into())
    );
}

#[test]
fn reports_when_the_macos_accessibility_tree_was_truncated() {
    let mut window = sample_windows()[0].clone();
    window.accessibility_truncated = true;

    let state = macos_get_window_state_result(&window, false);

    assert_eq!(state["accessibility"]["truncated"], true);
}

#[test]
fn aligns_macos_set_value_settable_boundary() {
    assert!(macos_set_value_attribute_is_settable(0, true, "AXValue").unwrap());
    assert!(!macos_set_value_attribute_is_settable(0, false, "AXValue").unwrap());
    assert_eq!(
        MACOS_NON_SETTABLE_SET_VALUE_ERROR,
        "Cannot set a value for an element that is not settable"
    );
    assert_eq!(
        macos_set_value_attribute_is_settable(-25205, false, "AXValue").unwrap_err(),
        "AXUIElementIsAttributeSettable(AXValue) failed with -25205"
    );
}

#[test]
fn prefers_accessibility_actions_for_macos_element_clicks() {
    assert_eq!(
        macos_preferred_click_actions(false),
        &["AXPress", "AXConfirm", "AXOpen"]
    );
    assert_eq!(macos_preferred_click_actions(true), &["AXShowMenu"]);
}

#[test]
fn defaults_macos_pointer_fallback_to_targeted_events() {
    assert!(!macos_global_pointer_fallback_enabled_from(None, None));
    assert_eq!(macos_pointer_input_mode(false), "targeted_event");
}

#[test]
fn parses_macos_global_pointer_fallback_opt_in_flags() {
    for value in ["1", "true", "yes", "on", "TRUE"] {
        assert!(macos_global_pointer_fallback_enabled_from(
            Some(value),
            None
        ));
        assert!(macos_global_pointer_fallback_enabled_from(
            None,
            Some(value)
        ));
    }

    for value in ["", "0", "false", "no", "off", "FALSE", "anything"] {
        assert!(!macos_global_pointer_fallback_enabled_from(
            Some(value),
            None
        ));
        assert!(!macos_global_pointer_fallback_enabled_from(
            None,
            Some(value)
        ));
    }
}

#[test]
fn reports_macos_physical_pointer_mode_only_for_explicit_fallback() {
    assert_eq!(macos_pointer_input_mode(true), "physical_pointer");
}

#[test]
fn defaults_macos_visible_pointer_to_enabled_with_open_computer_use_compatible_disable_flags() {
    assert!(macos_visible_pointer_enabled_from(None, None));
    for value in ["0", "false", "no", "off", "FALSE"] {
        assert!(!macos_visible_pointer_enabled_from(Some(value), None));
        assert!(!macos_visible_pointer_enabled_from(None, Some(value)));
    }
    assert!(macos_visible_pointer_enabled_from(Some("1"), None));
    assert_eq!(macos_visible_pointer_mode(true), "software_cursor");
    assert_eq!(macos_visible_pointer_mode(false), "disabled");
}

#[test]
fn builds_macos_visible_pointer_motion_with_intermediate_frames_and_final_target() {
    let frames = macos_visible_pointer_motion_points((10, 20), (410, 320), (0, 0, 1440, 900));

    assert!(frames.len() > 2);
    assert_ne!(frames[0], (410, 320));
    assert_eq!(frames.last(), Some(&(410, 320)));
}

#[test]
fn skips_macos_visible_pointer_animation_when_already_at_target() {
    let frames = macos_visible_pointer_motion_points((100, 100), (101, 102), (0, 0, 1440, 900));

    assert_eq!(frames, vec![(101, 102)]);
}

#[test]
fn parses_macos_key_chords_for_common_agent_shortcuts() {
    assert_eq!(macos_key_chord(&["COMMAND", "A"]), Some((0, 0x0010_0000)));
    assert_eq!(
        macos_key_chord(&["CTRL", "SHIFT", "ENTER"]),
        Some((36, 0x0006_0000))
    );
    assert_eq!(macos_key_chord(&["not-a-key"]), None);
}
