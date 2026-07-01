use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::fs;

#[derive(Debug, Clone)]
pub struct ConfigStore {
    codex_home: PathBuf,
    config_file: PathBuf,
}

impl ConfigStore {
    pub fn new(codex_home: PathBuf, config_file: PathBuf) -> Self {
        Self {
            codex_home,
            config_file,
        }
    }

    pub async fn handle(&self, message: &Map<String, Value>) -> Result<Value> {
        let action = string(message, "action")?;
        match action {
            "read_toml" => {
                let path = self.resolve_toml_path(string(message, "path")?).await?;
                self.read_toml(&path).await
            }
            "write_toml" => {
                let path = self.resolve_toml_path(string(message, "path")?).await?;
                let value = message.get("value").cloned().unwrap_or_else(|| json!({}));
                let expected = message.get("expected_version").and_then(Value::as_str);
                self.write_toml(&path, &value, expected).await
            }
            "read_config" => {
                self.read_config(
                    message
                        .get("include_layers")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await
            }
            "read_requirements" => Ok(json!({ "requirements": [], "version": Value::Null })),
            "write_config_value" => {
                let expected = message.get("expected_version").and_then(Value::as_str);
                let key_path = string(message, "key_path")?;
                let value = message.get("value").cloned().unwrap_or(Value::Null);
                let replace =
                    message.get("merge_strategy").and_then(Value::as_str) == Some("replace");
                self.write_value(key_path, value, replace, expected).await
            }
            "batch_write_config" => {
                let expected = message.get("expected_version").and_then(Value::as_str);
                let edits = message
                    .get("edits")
                    .and_then(Value::as_array)
                    .ok_or_else(|| anyhow!("edits must be an array"))?;
                self.batch_write(edits, expected).await
            }
            other => bail!("Unsupported config action: {other}"),
        }
    }

    async fn read_config(&self, include_layers: bool) -> Result<Value> {
        let value = self
            .read_toml(&self.config_file)
            .await
            .unwrap_or_else(|_| json!({}));
        let bytes = fs::read(&self.config_file).await.unwrap_or_default();
        let version = sha256(&bytes);
        if include_layers {
            Ok(
                json!({ "config": value.clone(), "layers": [{ "path": self.config_file, "config": value }], "version": version }),
            )
        } else {
            Ok(json!({ "config": value, "version": version }))
        }
    }

    async fn read_toml(&self, path: &Path) -> Result<Value> {
        let text = match fs::read_to_string(path).await {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        let parsed: toml::Value =
            toml::from_str(&text).with_context(|| format!("parse TOML {}", path.display()))?;
        serde_json::to_value(parsed).context("convert TOML to JSON")
    }

    async fn write_toml(
        &self,
        path: &Path,
        value: &Value,
        expected_version: Option<&str>,
    ) -> Result<Value> {
        let existing = fs::read(path).await.unwrap_or_default();
        if let Some(expected) = expected_version {
            let actual = sha256(&existing);
            if expected != actual {
                bail!("config version conflict: expected {expected}, actual {actual}");
            }
        }
        let toml_value: toml::Value =
            serde_json::from_value(value.clone()).context("convert JSON to TOML")?;
        let text = toml::to_string_pretty(&toml_value).context("serialize TOML")?;
        self.atomic_write(path, text.as_bytes()).await?;
        Ok(json!({ "version": sha256(text.as_bytes()), "config": value }))
    }

    async fn write_value(
        &self,
        key_path: &str,
        value: Value,
        replace: bool,
        expected: Option<&str>,
    ) -> Result<Value> {
        let mut config = self
            .read_toml(&self.config_file)
            .await
            .unwrap_or_else(|_| json!({}));
        set_json_path(&mut config, key_path, value, replace)?;
        self.write_toml(&self.config_file, &config, expected).await
    }

    async fn batch_write(&self, edits: &[Value], expected: Option<&str>) -> Result<Value> {
        let mut config = self
            .read_toml(&self.config_file)
            .await
            .unwrap_or_else(|_| json!({}));
        for edit in edits {
            let object = edit
                .as_object()
                .ok_or_else(|| anyhow!("config edit must be an object"))?;
            let key_path = string(object, "key_path")?;
            let value = object.get("value").cloned().unwrap_or(Value::Null);
            let replace = object.get("merge_strategy").and_then(Value::as_str) == Some("replace");
            set_json_path(&mut config, key_path, value, replace)?;
        }
        self.write_toml(&self.config_file, &config, expected).await
    }

    async fn atomic_write(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .await
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let temp = path.with_extension(format!("toml.tmp-{}", uuid::Uuid::new_v4()));
        fs::write(&temp, bytes)
            .await
            .with_context(|| format!("write {}", temp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await?;
        }
        #[cfg(windows)]
        if fs::try_exists(path).await.unwrap_or(false) {
            fs::remove_file(path)
                .await
                .with_context(|| format!("remove existing {}", path.display()))?;
        }
        fs::rename(&temp, path)
            .await
            .with_context(|| format!("replace {}", path.display()))?;
        Ok(())
    }

    async fn resolve_toml_path(&self, input: &str) -> Result<PathBuf> {
        let path = Path::new(input);
        if path.is_absolute() {
            bail!("TOML path must be relative to CODEX_HOME");
        }
        if path.extension().and_then(|value| value.to_str()) != Some("toml") {
            bail!("TOML path must end in .toml");
        }
        if path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            bail!("TOML path cannot escape CODEX_HOME");
        }
        let joined = self.codex_home.join(path);
        let mut cursor = self.codex_home.clone();
        for component in path.components() {
            cursor.push(component.as_os_str());
            if let Ok(meta) = fs::symlink_metadata(&cursor).await {
                if meta.file_type().is_symlink() {
                    bail!("TOML path cannot traverse a symbolic link");
                }
            }
        }
        Ok(joined)
    }
}

fn string<'a>(map: &'a Map<String, Value>, name: &str) -> Result<&'a str> {
    map.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{name} must be a string"))
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn set_json_path(root: &mut Value, key_path: &str, value: Value, replace: bool) -> Result<()> {
    let parts: Vec<&str> = key_path
        .split('.')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        bail!("key_path must not be empty");
    }
    let mut cursor = root;
    for part in &parts[..parts.len() - 1] {
        if !cursor.is_object() {
            *cursor = json!({});
        }
        cursor = cursor
            .as_object_mut()
            .unwrap()
            .entry((*part).to_string())
            .or_insert_with(|| json!({}));
    }
    let key = parts.last().unwrap().to_string();
    let object = cursor
        .as_object_mut()
        .ok_or_else(|| anyhow!("config parent is not an object"))?;
    if replace || !object.contains_key(&key) {
        object.insert(key, value);
        return Ok(());
    }
    match (object.get_mut(&key), value) {
        (Some(Value::Object(existing)), Value::Object(incoming)) => existing.extend(incoming),
        (Some(slot), incoming) => *slot = incoming,
        (None, incoming) => {
            object.insert(key, incoming);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{set_json_path, ConfigStore};
    use serde_json::{json, Map, Value};
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temporary_root() -> PathBuf {
        std::env::temp_dir().join(format!("lume-cua-config-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn merges_and_replaces_nested_values() {
        let mut value = json!({ "features": { "cua": { "enabled": false, "keep": 1 } } });
        set_json_path(
            &mut value,
            "features.cua",
            json!({ "enabled": true }),
            false,
        )
        .unwrap();
        assert_eq!(value["features"]["cua"]["enabled"], true);
        assert_eq!(value["features"]["cua"]["keep"], 1);

        set_json_path(&mut value, "features.cua", json!({ "fresh": true }), true).unwrap();
        assert_eq!(value["features"]["cua"], json!({ "fresh": true }));
    }

    #[tokio::test]
    async fn write_toml_honors_expected_version() {
        let root = temporary_root();
        let config_file = root.join("config.toml");
        let store = ConfigStore::new(root.clone(), config_file);

        let mut write = Map::new();
        write.insert("action".into(), Value::String("write_toml".into()));
        write.insert("path".into(), Value::String("skills/demo.toml".into()));
        write.insert("value".into(), json!({ "enabled": true }));
        let first = store.handle(&write).await.unwrap();
        let version = first["version"].as_str().unwrap().to_string();

        write.insert("value".into(), json!({ "enabled": false }));
        write.insert("expected_version".into(), Value::String(version));
        assert!(store.handle(&write).await.is_ok());

        write.insert("expected_version".into(), Value::String("0".repeat(64)));
        let error = store.handle(&write).await.unwrap_err().to_string();
        assert!(error.contains("config version conflict"));

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn rejects_escaping_and_non_toml_paths() {
        let root = temporary_root();
        let store = ConfigStore::new(root.clone(), root.join("config.toml"));
        for invalid in ["../escape.toml", "settings.json"] {
            let mut request = Map::new();
            request.insert("action".into(), Value::String("read_toml".into()));
            request.insert("path".into(), Value::String(invalid.into()));
            assert!(store.handle(&request).await.is_err());
        }
    }
}
