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
    eprintln!("{}", log_line(level, context, event, message, data));
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
    fn data_field_is_attached_when_present() {
        let line = log_line("info", "c", "e", "m", Some(serde_json::json!({"k": 1})));
        let parsed: Value = serde_json::from_str(&line[LUMELOG_PREFIX.len()..]).unwrap();
        assert_eq!(parsed["data"]["k"], 1);
    }
}
