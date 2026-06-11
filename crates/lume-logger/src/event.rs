use serde::Serialize;

use crate::level::LumeLogLevel;

/// A single NDJSON log entry.
///
/// For P1, all extra context (request_id, method, tool_name, etc.) goes into
/// the `data` field as a JSON object. This keeps the top-level schema simple
/// while still being fully structured and searchable.
#[derive(Debug, Clone, Serialize)]
pub struct LumeLogEvent {
    /// ISO-8601 timestamp, e.g. "2026-06-09T08:00:00.123Z"
    pub ts: String,
    /// Log level.
    pub level: LumeLogLevel,
    /// Origin: "desktop", "sidecar", "sidecar.stderr", "webview"
    pub source: String,
    /// Dot-separated context, e.g. "desktop.sidecar.rpc"
    pub context: String,
    /// Human-readable message.
    pub message: String,
    /// Optional structured data (extra fields, error info, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_minimal() {
        let event = LumeLogEvent {
            ts: "2026-06-09T08:00:00.000Z".into(),
            level: LumeLogLevel::Info,
            source: "desktop".into(),
            context: "desktop.app.boot".into(),
            message: "desktop started".into(),
            data: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"level\":\"info\""));
        assert!(json.contains("\"source\":\"desktop\""));
        assert!(!json.contains("\"data\""));
    }

    #[test]
    fn serialize_with_data() {
        let event = LumeLogEvent {
            ts: "2026-06-09T08:00:00.000Z".into(),
            level: LumeLogLevel::Debug,
            source: "desktop".into(),
            context: "desktop.sidecar.rpc".into(),
            message: "request started".into(),
            data: Some(serde_json::json!({
                "request_id": "42",
                "method": "agent.run"
            })),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"request_id\":\"42\""));
        assert!(json.contains("\"method\":\"agent.run\""));
        // Should be single-line (NDJSON requirement)
        assert!(!json.contains('\n'));
    }
}
