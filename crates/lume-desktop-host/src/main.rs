use std::{env, io::ErrorKind};

use anyhow::{bail, Context, Result};
use lume_desktop_host::{DesktopBackend, DesktopSession, UnsupportedBackend};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("lume_desktop_host failed: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let endpoint = parse_endpoint()?;
    let token =
        env::var("LUME_DESKTOP_HOST_TOKEN").context("LUME_DESKTOP_HOST_TOKEN is required")?;
    serve(&endpoint, token).await
}

fn parse_endpoint() -> Result<String> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--endpoint" {
            return args.next().context("--endpoint requires a value");
        }
    }
    bail!("--endpoint is required")
}

fn create_backend() -> Box<dyn DesktopBackend> {
    #[cfg(windows)]
    {
        return Box::new(lume_desktop_host::windows_backend::WindowsDesktopBackend);
    }
    #[allow(unreachable_code)]
    Box::new(UnsupportedBackend)
}

async fn handle_stream<S>(mut stream: S, token: String) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut session = DesktopSession::new(token, create_backend());
    loop {
        let body_length = match stream.read_u32_le().await {
            Ok(length) => length as usize,
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if body_length > MAX_FRAME_BYTES {
            bail!("desktop host frame exceeds {MAX_FRAME_BYTES} bytes");
        }
        let mut body = vec![0_u8; body_length];
        stream.read_exact(&mut body).await?;
        let request: Value = serde_json::from_slice(&body)?;
        let response = serde_json::to_vec(&session.handle(request))?;
        stream.write_u32_le(response.len() as u32).await?;
        stream.write_all(&response).await?;
        stream.flush().await?;
    }
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
    use tokio::net::UnixListener;

    let _ = std::fs::remove_file(endpoint);
    let listener =
        UnixListener::bind(endpoint).with_context(|| format!("bind unix socket {endpoint}"))?;
    loop {
        let (stream, _) = listener.accept().await?;
        if let Err(error) = handle_stream(stream, token.clone()).await {
            eprintln!("desktop host client disconnected: {error:#}");
        }
    }
}
