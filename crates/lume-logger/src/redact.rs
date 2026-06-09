/// Redact sensitive values from JSON data before writing to log files.
///
/// Ported from sidecar's `isSensitiveDiagnosticKey` / `redactDiagnosticLogData`.

const REDACTED: &str = "[REDACTED]";

/// Default sensitive key patterns (lowercased, stripped of `-_/s`).
const DEFAULT_PATTERNS: &[&str] = &[
    "token",
    "secret",
    "password",
    "apikey",
    "authorization",
    "cookie",
    "setcookie",
    "accesstoken",
    "refreshtoken",
];

/// Normalize a key for matching: lowercase, strip hyphens/underscores/spaces.
fn normalize_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for ch in key.chars() {
        match ch {
            '-' | '_' | ' ' => {}
            _ => out.extend(ch.to_lowercase()),
        }
    }
    out
}

/// Check if a normalized key matches any sensitive pattern.
pub fn is_sensitive_key(key: &str, patterns: &[String]) -> bool {
    let normalized = normalize_key(key);
    patterns.iter().any(|p| normalized.contains(p.as_str()))
}

/// Recursively redact sensitive values in a JSON tree.
///
/// Mutates `value` in place. Any object key matching the configured patterns
/// has its value replaced with `"[REDACTED]"`.
pub fn redact_value(value: &mut serde_json::Value, patterns: &[String]) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if is_sensitive_key(k, patterns) {
                    *v = serde_json::Value::String(REDACTED.into());
                } else {
                    redact_value(v, patterns);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                redact_value(item, patterns);
            }
        }
        _ => {}
    }
}

/// Build the normalized pattern list from config redact_keys (or defaults).
pub fn default_patterns() -> Vec<String> {
    DEFAULT_PATTERNS.iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redact_simple() {
        let patterns = default_patterns();
        let mut val = json!({"apiKey": "sk-xxx", "name": "test"});
        redact_value(&mut val, &patterns);
        assert_eq!(val["apiKey"], "[REDACTED]");
        assert_eq!(val["name"], "test");
    }

    #[test]
    fn redact_nested() {
        let patterns = default_patterns();
        let mut val = json!({
            "user": {
                "name": "alice",
                "token": "abc123"
            }
        });
        redact_value(&mut val, &patterns);
        assert_eq!(val["user"]["name"], "alice");
        assert_eq!(val["user"]["token"], "[REDACTED]");
    }

    #[test]
    fn redact_case_insensitive() {
        let patterns = default_patterns();
        let mut val = json!({"Authorization": "Bearer xyz", "API_KEY": "sk-123"});
        redact_value(&mut val, &patterns);
        assert_eq!(val["Authorization"], "[REDACTED]");
        assert_eq!(val["API_KEY"], "[REDACTED]");
    }

    #[test]
    fn redact_array() {
        let patterns = default_patterns();
        let mut val = json!([
            {"password": "secret1"},
            {"name": "ok"}
        ]);
        redact_value(&mut val, &patterns);
        assert_eq!(val[0]["password"], "[REDACTED]");
        assert_eq!(val[1]["name"], "ok");
    }

    #[test]
    fn normalize_key_examples() {
        assert_eq!(normalize_key("Set-Cookie"), "setcookie");
        assert_eq!(normalize_key("API_KEY"), "apikey");
        assert_eq!(normalize_key("access_token"), "accesstoken");
    }
}
