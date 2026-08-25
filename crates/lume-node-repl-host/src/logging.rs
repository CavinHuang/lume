use std::io::Write;

use serde_json::Value;

/// Single-line structured log protocol consumed by the desktop supervisor.
pub const LUMELOG_PREFIX: &str = "LUMELOG ";

pub fn log_line(level: &str, context: &str, event: &str, message: &str, data: Option<Value>) -> String {
    let mut payload = serde_json::json!({
        "level": level,
        "context": context,
        "event": event,
        "message": message,
    });
    if let Some(data) = data {
        payload["data"] = data;
    }
    format!("{LUMELOG_PREFIX}{payload}")
}

pub fn emit_log(level: &str, context: &str, event: &str, message: &str, data: Option<Value>) {
    // 写 stderr 失败（如父进程已死导致 EPIPE）只丢日志，不得 panic 拖垮宿主。
    let _ = writeln!(std::io::stderr().lock(), "{}", log_line(level, context, event, message, data));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_has_prefix_and_parses_back() {
        let line = log_line("warn", "host.pipe", "pipe.error", "boom", None);
        assert!(line.starts_with(LUMELOG_PREFIX));
        let parsed: Value =
            serde_json::from_str(&line[LUMELOG_PREFIX.len()..]).expect("valid json");
        assert_eq!(parsed["event"], "pipe.error");
        assert_eq!(parsed["level"], "warn");
        assert_eq!(parsed["message"], "boom");
    }

    #[test]
    fn mirrors_sibling_copy() {
        // 两 crate 无共享依赖，logging.rs 是刻意的双份拷贝——此测试防止漂移。
        // include_str 路径行指向对方、必然不同，比对前剔除。
        let strip_include = |text: &str| {
            text.lines()
                .filter(|line| !line.contains("-host/src/logging.rs"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(
            strip_include(include_str!("logging.rs")),
            strip_include(include_str!("../../lume-desktop-host/src/logging.rs")),
        );
    }

    #[test]
    fn data_field_is_attached_when_present() {
        let line = log_line("info", "c", "e", "m", Some(serde_json::json!({"k": 1})));
        let parsed: Value = serde_json::from_str(&line[LUMELOG_PREFIX.len()..]).unwrap();
        assert_eq!(parsed["data"]["k"], 1);
    }
}
