use std::{env, fs, io::ErrorKind};

use anyhow::{bail, Context, Result};
use lume_desktop_host::{
    desktop_events::{start_desktop_event_monitor, DesktopEventMonitor},
    DesktopBackend, DesktopSession, UnsupportedBackend,
};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[cfg_attr(not(unix), allow(dead_code))]
fn private_unix_socket_mode() -> u32 {
    0o600
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("lume_desktop_host failed: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    #[cfg(windows)]
    lume_desktop_host::initialize_windows_runtime().context("enable per-monitor DPI awareness")?;
    let args = parse_host_args()?;
    let token = read_session_token(&args)?;
    serve(&args.endpoint, token).await
}

struct HostArgs {
    endpoint: String,
    token_file: Option<String>,
}

fn parse_host_args() -> Result<HostArgs> {
    parse_host_args_from(env::args().skip(1))
}

fn parse_host_args_from(args: impl IntoIterator<Item = String>) -> Result<HostArgs> {
    let mut args = args.into_iter();
    let mut endpoint = None;
    let mut token_file = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--endpoint" => {
                endpoint = Some(args.next().context("--endpoint requires a value")?);
            }
            "--token-file" => {
                token_file = Some(args.next().context("--token-file requires a value")?);
            }
            _ => {}
        }
    }
    Ok(HostArgs {
        endpoint: endpoint.context("--endpoint is required")?,
        token_file,
    })
}

fn read_session_token(args: &HostArgs) -> Result<String> {
    if let Some(path) = &args.token_file {
        let token = fs::read_to_string(path)
            .with_context(|| format!("read desktop host token file {path}"))?;
        fs::remove_file(path).with_context(|| format!("remove desktop host token file {path}"))?;
        return Ok(token);
    }
    env::var("LUME_DESKTOP_HOST_TOKEN").context("LUME_DESKTOP_HOST_TOKEN is required")
}

fn create_backend() -> Box<dyn DesktopBackend> {
    #[cfg(windows)]
    {
        return Box::new(lume_desktop_host::windows_backend::WindowsDesktopBackend);
    }
    #[cfg(target_os = "macos")]
    {
        return Box::new(lume_desktop_host::macos_backend::MacOSDesktopBackend);
    }
    #[allow(unreachable_code)]
    Box::new(UnsupportedBackend)
}

async fn handle_stream<S>(stream: S, token: String) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut session = DesktopSession::new(token, create_backend());
    let mut event_monitor: Option<DesktopEventMonitor> = None;
    loop {
        enum Incoming {
            Request(Result<Option<Value>>),
            Event(Option<Value>),
        }
        let incoming = if let Some(monitor) = event_monitor.as_mut() {
            tokio::select! {
                request = read_message(&mut reader) => Incoming::Request(request),
                event = monitor.recv() => Incoming::Event(event),
            }
        } else {
            Incoming::Request(read_message(&mut reader).await)
        };
        match incoming {
            Incoming::Request(request) => {
                let Some(request) = request? else {
                    return Ok(());
                };
                let event_subscription = request
                    .get("method")
                    .and_then(Value::as_str)
                    .filter(|method| *method == "system.set_event_subscription")
                    .map(|_| request["params"]["enabled"].as_bool().unwrap_or(false));
                let response = session.handle(request);
                write_message(&mut writer, &response).await?;
                if session.is_authenticated() {
                    match event_subscription {
                        Some(true) if event_monitor.is_none() => {
                            match start_desktop_event_monitor() {
                                Ok(monitor) => event_monitor = Some(monitor),
                                Err(error) => {
                                    eprintln!("desktop event monitor unavailable: {error:#}")
                                }
                            }
                        }
                        Some(false) => event_monitor = None,
                        _ => {}
                    }
                }
            }
            Incoming::Event(Some(event)) => write_message(&mut writer, &event).await?,
            Incoming::Event(None) => event_monitor = None,
        }
    }
}

async fn read_message<R>(reader: &mut R) -> Result<Option<Value>>
where
    R: AsyncRead + Unpin,
{
    let body_length = match reader.read_u32_le().await {
        Ok(length) => length as usize,
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if body_length > MAX_FRAME_BYTES {
        bail!("desktop host frame exceeds {MAX_FRAME_BYTES} bytes");
    }
    let mut body = vec![0_u8; body_length];
    reader.read_exact(&mut body).await?;
    Ok(Some(serde_json::from_slice(&body)?))
}

async fn write_message<W>(writer: &mut W, message: &Value) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let response = serde_json::to_vec(message)?;
    writer.write_u32_le(response.len() as u32).await?;
    writer.write_all(&response).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(windows)]
async fn serve(endpoint: &str, token: String) -> Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut first = true;
    loop {
        let server = ServerOptions::new()
            .first_pipe_instance(first)
            .create(endpoint)
            .with_context(|| format!("create named pipe {endpoint}"))?;
        first = false;
        server.connect().await?;
        if let Err(error) = handle_stream(server, token.clone()).await {
            eprintln!("desktop host client disconnected: {error:#}");
        }
    }
}

#[cfg(unix)]
async fn serve(endpoint: &str, token: String) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let _ = std::fs::remove_file(endpoint);
    let listener =
        UnixListener::bind(endpoint).with_context(|| format!("bind unix socket {endpoint}"))?;
    fs::set_permissions(
        endpoint,
        fs::Permissions::from_mode(private_unix_socket_mode()),
    )
    .with_context(|| format!("restrict unix socket permissions {endpoint}"))?;
    loop {
        let (stream, _) = listener.accept().await?;
        if let Err(error) = handle_stream(stream, token.clone()).await {
            eprintln!("desktop host client disconnected: {error:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn parse_host_args_accepts_endpoint_and_token_file() {
        let args = parse_host_args_from([
            "--endpoint".to_owned(),
            "/tmp/lume.sock".to_owned(),
            "--token-file".to_owned(),
            "/tmp/lume.sock.token".to_owned(),
        ])
        .unwrap();

        assert_eq!(args.endpoint, "/tmp/lume.sock");
        assert_eq!(args.token_file.as_deref(), Some("/tmp/lume.sock.token"));
    }

    #[test]
    fn reads_session_token_from_token_file_and_removes_it() {
        let path = unique_token_path();
        fs::write(&path, "secret-token").unwrap();
        let args = HostArgs {
            endpoint: "/tmp/lume.sock".to_owned(),
            token_file: Some(path.to_string_lossy().into_owned()),
        };

        assert_eq!(read_session_token(&args).unwrap(), "secret-token");
        assert!(!path.exists());
    }

    #[test]
    fn unix_socket_permission_mode_is_current_user_only() {
        assert_eq!(private_unix_socket_mode(), 0o600);
    }

    fn unique_token_path() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lume-desktop-host-token-{}-{stamp}",
            std::process::id()
        ))
    }
}
