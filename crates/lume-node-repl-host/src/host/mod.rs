pub mod config;
pub mod image;

use std::{path::PathBuf, process::Stdio};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Method,
};
use serde_json::{json, Map, Value};
use tokio::process::Command;
use url::Url;

use self::{config::ConfigStore, image::ImageStore};
use crate::protocol::ExecutionImage;

#[derive(Clone)]
pub struct HostServices {
    pub image_store: ImageStore,
    pub config_store: ConfigStore,
    pub cwd: PathBuf,
    pub allowed_fetch_origins: Vec<String>,
}

impl HostServices {
    pub async fn emit_image(&self, image_url: &str) -> Result<ExecutionImage> {
        self.image_store.save(image_url).await
    }

    pub async fn config_action(&self, message: &Map<String, Value>) -> Result<Value> {
        self.config_store.handle(message).await
    }

    pub async fn authenticated_fetch(&self, request: &Map<String, Value>) -> Result<Value> {
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("GET");
        let url_text = request
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("url must be a string"))?;
        let url = Url::parse(url_text).context("parse fetch URL")?;
        if !self.allowed_fetch_origins.is_empty() {
            let origin = url.origin().ascii_serialization();
            if !self
                .allowed_fetch_origins
                .iter()
                .any(|allowed| allowed == &origin)
            {
                bail!("Fetch origin is not allowed: {origin}");
            }
        }
        let mut headers = HeaderMap::new();
        if let Some(entries) = request.get("headers").and_then(Value::as_array) {
            for entry in entries {
                let object = entry
                    .as_object()
                    .ok_or_else(|| anyhow!("fetch header must be an object"))?;
                let name = object
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("header name must be a string"))?;
                let value = object
                    .get("value")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("header value must be a string"))?;
                headers.append(
                    HeaderName::from_bytes(name.as_bytes())?,
                    HeaderValue::from_str(value)?,
                );
            }
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let mut builder = client
            .request(Method::from_bytes(method.as_bytes())?, url)
            .headers(headers);
        if let Some(body) = request.get("body_base64").and_then(Value::as_str) {
            builder = builder.body(STANDARD.decode(body).context("decode fetch body")?);
        }
        let response = builder.send().await.context("authenticated fetch")?;
        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or("").to_string();
        let response_headers = response.headers().iter().map(|(name, value)| {
            json!({ "name": name.as_str(), "value": value.to_str().unwrap_or("") })
        }).collect::<Vec<_>>();
        let body = response.bytes().await.context("read fetch response")?;
        Ok(json!({
            "status": status.as_u16(),
            "status_text": status_text,
            "headers": response_headers,
            "body_base64": if body.is_empty() { Value::Null } else { Value::String(STANDARD.encode(body)) }
        }))
    }

    pub async fn launch_application(&self, message: &Map<String, Value>) -> Result<Value> {
        let application_path = message.get("application_path").and_then(Value::as_str);
        let _bundle_identifier = message.get("bundle_identifier").and_then(Value::as_str);
        let mut command;
        #[cfg(target_os = "macos")]
        {
            command = Command::new("open");
            if let Some(path) = application_path {
                command.arg(path);
            } else if let Some(bundle) = _bundle_identifier {
                command.args(["-b", bundle]);
            } else {
                bail!("missing application target");
            }
        }
        #[cfg(target_os = "windows")]
        {
            let path =
                application_path.ok_or_else(|| anyhow!("Windows requires applicationPath"))?;
            command = Command::new("cmd.exe");
            command.args(["/d", "/s", "/c", "start", "", path]);
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let path = application_path.ok_or_else(|| anyhow!("Linux requires applicationPath"))?;
            command = Command::new("xdg-open");
            command.arg(path);
        }
        command
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false);
        let child = command.spawn().context("launch application")?;
        Ok(json!({ "pid": child.id() }))
    }
}
