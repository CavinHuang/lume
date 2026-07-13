use anyhow::{anyhow, Context, Result};
use std::{slice, sync::mpsc, time::Duration};
use windows::{
    core::{factory, Interface},
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::{HMODULE, HWND},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
                D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
                D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_USAGE_STAGING,
            },
            Dxgi::{IDXGIAdapter, IDXGIDevice},
        },
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
            RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
        },
    },
};

pub struct CapturedBgra {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

thread_local! {
    static WINRT_APARTMENT: std::result::Result<RoApartment, windows::core::Error> =
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map(|_| RoApartment);
}

pub fn capture_window_bgra(hwnd: HWND, timeout: Duration) -> Result<CapturedBgra> {
    ensure_winrt_apartment()?;
    if !GraphicsCaptureSession::IsSupported()? {
        return Err(anyhow!("Windows.Graphics.Capture is unavailable"));
    }

    let (device, context) = create_d3d11_device()?;
    let dxgi_device: IDXGIDevice = device.cast()?;
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)? };
    let winrt_device: IDirect3DDevice = inspectable.cast()?;
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd)? };
    let size = item.Size()?;
    if size.Width <= 0 || size.Height <= 0 {
        return Err(anyhow!("capture item has invalid dimensions"));
    }

    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        1,
        size,
    )?;
    let session = pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsCursorCaptureEnabled(false);
    let (sender, receiver) = mpsc::sync_channel(1);
    let token = pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
        let _ = sender.try_send(());
        Ok(())
    }))?;

    session.StartCapture()?;
    let receive_result = receiver
        .recv_timeout(timeout)
        .context("Windows.Graphics.Capture frame timed out");
    let frame_result = receive_result.and_then(|_| {
        pool.TryGetNextFrame()
            .context("Windows.Graphics.Capture returned no frame")
    });
    let _ = pool.RemoveFrameArrived(token);
    let _ = session.Close();
    let frame = frame_result?;
    let content_size = frame.ContentSize()?;
    let surface = frame.Surface()?;
    let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
    let source: ID3D11Texture2D = unsafe { access.GetInterface()? };
    let capture = read_texture_bgra(
        &device,
        &context,
        &source,
        content_size.Width,
        content_size.Height,
    );
    let _ = frame.Close();
    let _ = pool.Close();
    capture
}

fn ensure_winrt_apartment() -> Result<()> {
    WINRT_APARTMENT.with(|apartment| {
        apartment
            .as_ref()
            .map(|_| ())
            .map_err(|error| anyhow!(error.to_string()))
    })
}

struct RoApartment;

impl Drop for RoApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP]
        .into_iter()
        .find_map(|driver_type| {
            let mut device = None;
            let mut context = None;
            let result = unsafe {
                D3D11CreateDevice(
                    None::<&IDXGIAdapter>,
                    driver_type,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
            };
            result.ok()?;
            Some((device?, context?))
        })
        .ok_or_else(|| anyhow!("unable to create a D3D11 capture device"))
}

fn read_texture_bgra(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    source: &ID3D11Texture2D,
    content_width: i32,
    content_height: i32,
) -> Result<CapturedBgra> {
    let mut description = Default::default();
    unsafe { source.GetDesc(&mut description) };
    let width = content_width.max(0) as u32;
    let height = content_height.max(0) as u32;
    if width == 0 || height == 0 || width > description.Width || height > description.Height {
        return Err(anyhow!("capture frame has invalid content dimensions"));
    }
    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    description.MiscFlags = 0;

    let mut staging = None;
    unsafe { device.CreateTexture2D(&description, None, Some(&mut staging))? };
    let staging = staging.ok_or_else(|| anyhow!("D3D11 did not create a staging texture"))?;
    unsafe { context.CopyResource(&staging, source) };

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))? };
    let row_bytes = width as usize * 4;
    let row_pitch = mapped.RowPitch as usize;
    if mapped.pData.is_null() || row_pitch < row_bytes {
        unsafe { context.Unmap(&staging, 0) };
        return Err(anyhow!("D3D11 returned an invalid mapped texture"));
    }
    let Some(mapped_len) = row_pitch.checked_mul(description.Height as usize) else {
        unsafe { context.Unmap(&staging, 0) };
        return Err(anyhow!("capture dimensions are too large"));
    };
    let mapped_bytes = unsafe { slice::from_raw_parts(mapped.pData.cast::<u8>(), mapped_len) };
    let mut pixels = Vec::with_capacity(row_bytes * height as usize);
    for row in mapped_bytes.chunks_exact(row_pitch).take(height as usize) {
        pixels.extend_from_slice(&row[..row_bytes]);
    }
    unsafe { context.Unmap(&staging, 0) };
    Ok(CapturedBgra {
        width,
        height,
        pixels,
    })
}
