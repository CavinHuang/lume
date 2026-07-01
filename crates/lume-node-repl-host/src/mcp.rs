use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter},
    sync::{mpsc, oneshot, Mutex},
};
use uuid::Uuid;

use crate::{
    cli::SERVER_VERSION,
    kernel::{Elicitor, Runtime},
    protocol::{RpcRequest, RpcResponse},
};

pub const SERVER_NAME: &str = "node_repl";
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

const MCP_CONTRACT_JSON: &str = include_str!("../contracts/node-repl-mcp-contract.json");
static MCP_CONTRACT: OnceLock<Value> = OnceLock::new();

fn mcp_contract() -> &'static Value {
    MCP_CONTRACT.get_or_init(|| {
        serde_json::from_str(MCP_CONTRACT_JSON)
            .expect("embedded node_repl MCP contract must be valid JSON")
    })
}

fn contract_instructions() -> &'static str {
    mcp_contract()
        .get("instructions")
        .and_then(Value::as_str)
        .expect("node_repl MCP contract must define instructions")
}


fn contract_validation(key: &str) -> &'static str {
    mcp_contract()
        .get("validation")
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("node_repl MCP contract must define validation.{key}"))
}

fn contract_result(key: &str) -> &'static str {
    mcp_contract()
        .get("results")
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("node_repl MCP contract must define results.{key}"))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JsToolArgs {
    title: Option<String>,
    code: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct JsResetArgs {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JsAddNodeModuleDirArgs {
    path: String,
}

pub struct McpServer {
    runtime: Arc<Runtime>,
    writer_tx: mpsc::UnboundedSender<Value>,
    pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    active_executions: Arc<Mutex<HashMap<String, String>>>,
    form_elicitation_supported: Arc<AtomicBool>,
}

impl McpServer {
    pub async fn new(runtime: Arc<Runtime>) -> Self {
        let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let stdout = tokio::io::stdout();
            let mut writer = BufWriter::new(stdout);
            while let Some(value) = writer_rx.recv().await {
                if let Ok(bytes) = serde_json::to_vec(&value) {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                    if writer.write_all(b"\n").await.is_err() {
                        break;
                    }
                    if writer.flush().await.is_err() {
                        break;
                    }
                }
            }
        });
        let pending_elicitations = Arc::new(Mutex::new(HashMap::new()));
        let form_elicitation_supported = Arc::new(AtomicBool::new(false));
        let elicitor = Arc::new(McpElicitor {
            writer_tx: writer_tx.clone(),
            pending: pending_elicitations.clone(),
            supported: form_elicitation_supported.clone(),
        });
        runtime.set_elicitor(elicitor).await;
        Self {
            runtime,
            writer_tx,
            pending_elicitations,
            active_executions: Arc::new(Mutex::new(HashMap::new())),
            form_elicitation_supported,
        }
    }

    pub async fn run(self) -> Result<()> {
        let stdin = tokio::io::stdin();
        let mut lines = BufReader::new(stdin).lines();
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => {
                    self.send(serde_json::to_value(RpcResponse::failure(
                        Value::Null,
                        -32700,
                        "Parse error",
                    ))?);
                    continue;
                }
            };
            if value.get("method").is_none() && value.get("id").is_some() {
                self.resolve_server_response(value).await;
                continue;
            }
            let request: RpcRequest = match serde_json::from_value(value) {
                Ok(request) => request,
                Err(error) => {
                    self.send(serde_json::to_value(RpcResponse::failure(
                        Value::Null,
                        -32600,
                        error.to_string(),
                    ))?);
                    continue;
                }
            };
            if request.method.as_deref() == Some("notifications/cancelled") {
                self.handle_cancel(&request.params).await;
                continue;
            }
            let Some(id) = request.id.clone() else {
                continue;
            };
            let runtime = self.runtime.clone();
            let writer = self.writer_tx.clone();
            let active = self.active_executions.clone();
            let form_supported = self.form_elicitation_supported.clone();
            tokio::spawn(async move {
                let response = handle_request(runtime, active, form_supported, id, request).await;
                let _ = writer.send(serde_json::to_value(response).unwrap_or_else(|error| {
                    json!({
                        "jsonrpc": "2.0", "id": Value::Null,
                        "error": { "code": -32603, "message": error.to_string() }
                    })
                }));
            });
        }
        self.runtime.reset().await?;
        Ok(())
    }

    fn send(&self, value: Value) {
        let _ = self.writer_tx.send(value);
    }

    async fn resolve_server_response(&self, value: Value) {
        let key = id_key(value.get("id").unwrap_or(&Value::Null));
        if let Some(sender) = self.pending_elicitations.lock().await.remove(&key) {
            let _ = sender.send(value);
        }
    }

    async fn handle_cancel(&self, params: &Value) {
        let request_id = params.get("requestId").unwrap_or(&Value::Null);
        let key = id_key(request_id);
        if let Some(exec_id) = self.active_executions.lock().await.get(&key).cloned() {
            let _ = self.runtime.cancel(&exec_id).await;
        }
    }
}

async fn handle_request(
    runtime: Arc<Runtime>,
    active: Arc<Mutex<HashMap<String, String>>>,
    form_supported: Arc<AtomicBool>,
    id: Value,
    request: RpcRequest,
) -> RpcResponse {
    let method = request.method.as_deref().unwrap_or("");
    match method {
        "initialize" => {
            let supported = request
                .params
                .pointer("/capabilities/elicitation/form")
                .is_some();
            form_supported.store(supported, Ordering::Relaxed);
            let protocol = request
                .params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-03-26");
            RpcResponse::success(
                id,
                json!({
                    "protocolVersion": protocol,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
                    "instructions": contract_instructions(),
                }),
            )
        }
        "notifications/initialized" | "ping" => RpcResponse::success(id, json!({})),
        "tools/list" => RpcResponse::success(id, json!({ "tools": tool_definitions() })),
        "tools/call" => {
            match call_tool(runtime, active, form_supported, &id, &request.params).await {
                Ok(value) => RpcResponse::success(id, value),
                Err(error) => RpcResponse::success(id, tool_error(error.to_string())),
            }
        }
        _ => RpcResponse::failure(id, -32601, format!("Method not found: {method}")),
    }
}

async fn call_tool(
    runtime: Arc<Runtime>,
    active: Arc<Mutex<HashMap<String, String>>>,
    form_supported: Arc<AtomicBool>,
    rpc_id: &Value,
    params: &Value,
) -> Result<Value> {
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("Expected object parameters"))?;
    let name = string(object, "name")?;
    let args = object.get("arguments").cloned().unwrap_or_else(|| json!({}));
    match name {
        "js" => {
            let args: JsToolArgs = parse_args(args)?;
            let code = args.code;
            if code.trim().is_empty() {
                return Ok(tool_error(contract_validation("emptyCode")));
            }
            if let Some(title) = args.title.as_deref() {
                if title.is_empty() {
                    return Ok(tool_error(contract_validation("emptyTitle")));
                }
                if title.chars().count() > 120 {
                    return Ok(tool_error(contract_validation("titleTooLong")));
                }
            }
            let timeout_ms = match args.timeout_ms {
                Some(0) => return Ok(tool_error(contract_validation("invalidTimeout"))),
                Some(value) => value,
                None => DEFAULT_TIMEOUT_MS,
            };
            let exec_id = Uuid::new_v4().to_string();
            let request_key = id_key(rpc_id);
            active
                .lock()
                .await
                .insert(request_key.clone(), exec_id.clone());
            let request_meta = merge_request_meta(
                env::var("NODE_REPL_REQUEST_META").ok(),
                object.get("_meta").cloned(),
            );
            let result = runtime
                .execute(
                    exec_id,
                    code,
                    Some(Duration::from_millis(timeout_ms)),
                    request_meta,
                    form_supported.load(Ordering::Relaxed),
                )
                .await;
            active.lock().await.remove(&request_key);
            let execution = result?;
            let mut content = Vec::new();
            if !execution.output.is_empty() {
                content.push(json!({ "type": "text", "text": execution.output }));
            }
            if !execution.ok {
                content.push(json!({ "type": "text", "text": execution.error.clone().unwrap_or_else(|| "Execution failed".to_string()) }));
            }
            for image in execution.images {
                if let (Some(data), Some(mime_type)) = (image.data_base64, image.mime_type) {
                    content.push(json!({ "type": "image", "data": data, "mimeType": mime_type, "_meta": { "codex/imageDetail": "original" } }));
                } else if let Some(file_path) = image.file_path {
                    content.push(json!({ "type": "text", "text": file_path }));
                }
            }
            if content.is_empty() {
                content.push(json!({ "type": "text", "text": if execution.ok { "" } else { "Execution failed" } }));
            }
            let mut result = Map::new();
            result.insert("content".into(), Value::Array(content));
            result.insert("isError".into(), Value::Bool(!execution.ok));
            if let Some(meta) = execution.response_meta {
                result.insert("_meta".into(), meta);
            }
            Ok(Value::Object(result))
        }
        "js_reset" => {
            let _: JsResetArgs = parse_args(args)?;
            runtime.reset().await?;
            Ok(json!({ "content": [{ "type": "text", "text": contract_result("reset") }] }))
        }
        "js_add_node_module_dir" => {
            let args: JsAddNodeModuleDirArgs = parse_args(args)?;
            if args.path.is_empty() {
                return Ok(tool_error(contract_validation("emptyPath")));
            }
            let path = PathBuf::from(&args.path);
            if !path.is_absolute() {
                return Ok(tool_error(contract_validation("relativePath")));
            }
            if path.file_name().and_then(|name| name.to_str()) != Some("node_modules") {
                return Ok(tool_error(
                    contract_validation("notNodeModulesSuffix")
                        .replace("{path}", &path.display().to_string()),
                ));
            }
            let added = runtime.add_node_module_dir(path).await?;
            Ok(json!({ "content": [{ "type": "text", "text": added.to_string() }] }))
        }
        other => Err(anyhow!("Unknown tool: {other}")),
    }
}

struct McpElicitor {
    writer_tx: mpsc::UnboundedSender<Value>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    supported: Arc<AtomicBool>,
}

#[async_trait]
impl Elicitor for McpElicitor {
    async fn elicit(&self, message: &str, requested_schema: Value, meta: Value) -> Result<Value> {
        if !self.supported.load(Ordering::Relaxed) {
            return Ok(json!({ "action": "cancel", "content": Value::Null, "_meta": Value::Null }));
        }
        let request_id = format!("node-repl-elicit-{}", Uuid::new_v4());
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(id_key(&Value::String(request_id.clone())), sender);
        self.writer_tx
            .send(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "elicitation/create",
                "params": { "message": message, "requestedSchema": requested_schema, "_meta": meta }
            }))
            .map_err(|_| anyhow!("MCP output closed"))?;
        let response = tokio::time::timeout(Duration::from_secs(300), receiver).await??;
        if let Some(error) = response.get("error") {
            return Err(anyhow!("elicitation failed: {error}"));
        }
        Ok(response.get("result").cloned().unwrap_or_else(
            || json!({ "action": "cancel", "content": Value::Null, "_meta": Value::Null }),
        ))
    }
}

pub fn tool_definitions() -> Vec<Value> {
    mcp_contract()
        .get("tools")
        .and_then(Value::as_array)
        .expect("node_repl MCP contract must define tools")
        .clone()
}


fn tool_error(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }], "isError": true })
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{key} must be a string"))
}

fn parse_args<T>(value: Value) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(value).map_err(|error| anyhow!(error.to_string()))
}

fn id_key(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn merge_request_meta(encoded: Option<String>, request: Option<Value>) -> Option<Value> {
    let base = encoded
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned());
    let request = request.and_then(|value| value.as_object().cloned());
    match (base, request) {
        (None, None) => None,
        (Some(base), None) => Some(Value::Object(base)),
        (None, Some(request)) => Some(Value::Object(request)),
        (Some(mut base), Some(request)) => {
            base.extend(request);
            Some(Value::Object(base))
        }
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn recovered_contract_defines_the_exact_three_tools() {
        let tools = tool_definitions();
        let names = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(names, ["js", "js_reset", "js_add_node_module_dir"]);
        assert_eq!(
            mcp_contract().get("defaultTimeoutMs").and_then(Value::as_u64),
            Some(DEFAULT_TIMEOUT_MS)
        );
    }

    #[test]
    fn serde_argument_parsers_reject_unknown_fields() {
        let js_error = parse_args::<JsToolArgs>(json!({"code": "1", "extra": true}))
            .expect_err("unknown js field must fail")
            .to_string();
        assert_eq!(
            js_error,
            "unknown field `extra`, expected one of `title`, `code`, `timeout_ms`"
        );

        let reset_error = parse_args::<JsResetArgs>(json!({"extra": true}))
            .expect_err("unknown reset field must fail")
            .to_string();
        assert_eq!(reset_error, "unknown field `extra`, there are no fields");
    }
}
