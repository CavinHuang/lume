use std::{
    env, fs,
    io::{self, ErrorKind, Read},
};

use anyhow::{bail, Context, Result};
use lume_desktop_host::{
    desktop_events::{start_desktop_event_monitor, DesktopEventMonitor},
    DesktopBackend, DesktopSession, UnsupportedBackend,
};
use serde::{Deserialize, Serialize};
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
    match parse_host_mode()? {
        HostMode::Serve(args) => {
            let token = read_session_token(&args)?;
            serve(&args.endpoint, token).await
        }
        HostMode::AuthorizeUserPresence => authorize_user_presence(),
    }
}

enum HostMode {
    Serve(HostArgs),
    AuthorizeUserPresence,
}

struct HostArgs {
    endpoint: String,
    token_file: Option<String>,
}

fn parse_host_mode() -> Result<HostMode> {
    parse_host_mode_from(env::args().skip(1))
}

fn parse_host_mode_from(args: impl IntoIterator<Item = String>) -> Result<HostMode> {
    let mut args = args.into_iter();
    let mut endpoint = None;
    let mut token_file = None;
    let mut authorize_user_presence = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--endpoint" => {
                endpoint = Some(args.next().context("--endpoint requires a value")?);
            }
            "--token-file" => {
                token_file = Some(args.next().context("--token-file requires a value")?);
            }
            "--authorize-user-presence" => authorize_user_presence = true,
            _ => {}
        }
    }
    if authorize_user_presence {
        if endpoint.is_some() || token_file.is_some() {
            bail!("user-presence mode cannot be combined with host mode");
        }
        return Ok(HostMode::AuthorizeUserPresence);
    }
    Ok(HostMode::Serve(HostArgs {
        endpoint: endpoint.context("--endpoint is required")?,
        token_file,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserPresenceRequest {
    protocol_version: u64,
    nonce: String,
    window_handle: String,
    parent_pid: u32,
    parent_executable: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserPresenceResponse<'a> {
    protocol_version: u64,
    nonce: &'a str,
    parent_pid: u32,
    authorized: bool,
}

fn authorize_user_presence() -> Result<()> {
    let mut body = String::new();
    io::stdin()
        .take(16 * 1024)
        .read_to_string(&mut body)
        .context("read user-presence request")?;
    let request: UserPresenceRequest =
        serde_json::from_str(&body).context("parse user-presence request")?;
    validate_user_presence_request(&request)?;
    #[cfg(windows)]
    let authorized = authorize_windows_user_presence(&request)?;
    #[cfg(not(windows))]
    let authorized = false;
    serde_json::to_writer(
        io::stdout(),
        &UserPresenceResponse {
            protocol_version: 1,
            nonce: &request.nonce,
            parent_pid: request.parent_pid,
            authorized,
        },
    )?;
    Ok(())
}

fn validate_user_presence_request(request: &UserPresenceRequest) -> Result<()> {
    if request.protocol_version != 1 {
        bail!("unsupported user-presence protocol");
    }
    if request.nonce.len() != 64 || !request.nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid user-presence nonce");
    }
    if request.parent_pid == 0 || request.parent_executable.is_empty() {
        bail!("invalid user-presence parent");
    }
    if request.reason.is_empty() || request.reason.chars().count() > 160 {
        bail!("invalid user-presence reason");
    }
    request
        .window_handle
        .parse::<usize>()
        .context("invalid user-presence window handle")?;
    Ok(())
}

#[cfg(windows)]
fn authorize_windows_user_presence(request: &UserPresenceRequest) -> Result<bool> {
    use std::ffi::c_void;
    use windows::{
        core::HSTRING,
        Security::Credentials::UI::UserConsentVerificationResult,
        Win32::{
            Foundation::HWND,
            System::WinRT::{
                IUserConsentVerifierInterop, RoGetActivationFactory, RoInitialize, RoUninitialize,
                RO_INIT_MULTITHREADED,
            },
            UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
        },
    };
    use windows_future::IAsyncOperation;

    let hwnd = HWND(
        request
            .window_handle
            .parse::<usize>()
            .context("parse user-presence window handle")? as *mut c_void,
    );
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        bail!("user-presence parent window is invalid");
    }
    let mut window_pid = 0_u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut window_pid)) };
    if window_pid != request.parent_pid
        || !parent_executable_matches(window_pid, &request.parent_executable)?
    {
        bail!("user-presence parent identity mismatch");
    }

    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.context("initialize Windows Runtime")?;
    struct RoGuard;
    impl Drop for RoGuard {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    let _guard = RoGuard;
    let factory: IUserConsentVerifierInterop = unsafe {
        RoGetActivationFactory(&HSTRING::from(
            "Windows.Security.Credentials.UI.UserConsentVerifier",
        ))
    }
    .context("activate Windows user-consent verifier")?;
    let operation: IAsyncOperation<UserConsentVerificationResult> =
        unsafe { factory.RequestVerificationForWindowAsync(hwnd, &HSTRING::from(&request.reason)) }
            .context("request Windows user verification")?;
    Ok(operation.get()? == UserConsentVerificationResult::Verified)
}

#[cfg(windows)]
fn parent_executable_matches(parent_pid: u32, expected: &str) -> Result<bool> {
    use windows::{
        core::PWSTR,
        Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, parent_pid) }
        .context("open user-presence parent process")?;
    struct HandleGuard(windows::Win32::Foundation::HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    let _guard = HandleGuard(process);
    let mut path = vec![0_u16; 32_768];
    let mut length = path.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
    }
    .context("read user-presence parent executable")?;
    let actual = String::from_utf16(&path[..length as usize])
        .context("decode user-presence parent executable")?;
    Ok(actual.eq_ignore_ascii_case(expected))
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
        let HostMode::Serve(args) = parse_host_mode_from([
            "--endpoint".to_owned(),
            "/tmp/lume.sock".to_owned(),
            "--token-file".to_owned(),
            "/tmp/lume.sock.token".to_owned(),
        ])
        .unwrap() else {
            panic!("expected host mode");
        };

        assert_eq!(args.endpoint, "/tmp/lume.sock");
        assert_eq!(args.token_file.as_deref(), Some("/tmp/lume.sock.token"));
    }

    #[test]
    fn parses_one_shot_user_presence_mode_and_rejects_mixed_modes() {
        assert!(matches!(
            parse_host_mode_from(["--authorize-user-presence".to_owned()]).unwrap(),
            HostMode::AuthorizeUserPresence
        ));
        assert!(parse_host_mode_from([
            "--authorize-user-presence".to_owned(),
            "--endpoint".to_owned(),
            "/tmp/lume.sock".to_owned(),
        ])
        .is_err());
    }

    #[test]
    fn validates_user_presence_request_boundary() {
        let request = UserPresenceRequest {
            protocol_version: 1,
            nonce: "a".repeat(64),
            window_handle: "1234".to_owned(),
            parent_pid: 42,
            parent_executable: "C:\\Program Files\\Lume\\Lume.exe".to_owned(),
            reason: "Authorize saved password use".to_owned(),
        };
        assert!(validate_user_presence_request(&request).is_ok());
        assert!(validate_user_presence_request(&UserPresenceRequest {
            nonce: "not-a-nonce".to_owned(),
            ..request
        })
        .is_err());
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
