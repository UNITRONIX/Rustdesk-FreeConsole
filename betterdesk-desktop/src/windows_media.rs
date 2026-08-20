//! Windows screen and input boundary.
//!
//! The module is compiled into the Windows client only. The privileged helper
//! is not used for normal capture or input; it is reserved for service and
//! unattended-access changes.

use anyhow::Result;

#[derive(Debug, Clone)]
pub struct EncodedFrame {
    pub format: &'static str,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorInfo {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(windows)]
pub fn capture_primary_jpeg(quality: u8) -> Result<EncodedFrame> {
    use std::mem::size_of;

    use image::{codecs::jpeg::JpegEncoder, ImageBuffer, RgbImage};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, GetDeviceCaps, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HORZRES, SRCCOPY, VERTRES,
    };

    let screen = unsafe { GetDC(std::ptr::null_mut()) };
    if screen.is_null() {
        anyhow::bail!("GetDC failed");
    }
    let width = unsafe { GetDeviceCaps(screen, HORZRES as i32) };
    let height = unsafe { GetDeviceCaps(screen, VERTRES as i32) };
    if width <= 0 || height <= 0 {
        unsafe {
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        anyhow::bail!("invalid primary monitor dimensions");
    }

    let memory = unsafe { CreateCompatibleDC(screen) };
    let bitmap = unsafe { CreateCompatibleBitmap(screen, width, height) };
    if memory.is_null() || bitmap.is_null() {
        unsafe {
            if !memory.is_null() {
                DeleteDC(memory);
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap.cast());
            }
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        anyhow::bail!("cannot create screen capture surface");
    }
    let previous = unsafe { SelectObject(memory, bitmap.cast()) };
    let copied = unsafe { BitBlt(memory, 0, 0, width, height, screen, 0, 0, SRCCOPY) };
    if copied == 0 {
        unsafe {
            SelectObject(memory, previous);
            DeleteObject(bitmap.cast());
            DeleteDC(memory);
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        anyhow::bail!("BitBlt failed");
    }

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bgra = vec![0_u8; (width as usize) * (height as usize) * 4];
    let scanlines = unsafe {
        GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            bgra.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        SelectObject(memory, previous);
        DeleteObject(bitmap.cast());
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);
    }
    if scanlines == 0 {
        anyhow::bail!("GetDIBits failed");
    }

    let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for pixel in bgra.chunks_exact(4) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    let image: RgbImage = ImageBuffer::from_raw(width as u32, height as u32, rgb)
        .ok_or_else(|| anyhow::anyhow!("invalid captured frame dimensions"))?;
    let mut data = Vec::new();
    JpegEncoder::new_with_quality(&mut data, quality.clamp(1, 100)).encode_image(&image)?;
    Ok(EncodedFrame {
        format: "jpeg",
        width: width as u32,
        height: height as u32,
        data,
    })
}

#[cfg(not(windows))]
pub fn capture_primary_jpeg(_quality: u8) -> Result<EncodedFrame> {
    anyhow::bail!("Windows screen capture is unavailable on this platform")
}

#[cfg(windows)]
pub fn monitors() -> Vec<MonitorInfo> {
    use windows_sys::Win32::{
        Foundation::{LPARAM, RECT},
        Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO},
    };

    unsafe extern "system" fn callback(
        monitor: HMONITOR,
        _dc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> i32 {
        let monitors = &mut *(data as *mut Vec<MonitorInfo>);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info) != 0 {
            let rect = info.rcMonitor;
            monitors.push(MonitorInfo {
                index: monitors.len() as u32,
                x: rect.left,
                y: rect.top,
                width: (rect.right - rect.left).max(0) as u32,
                height: (rect.bottom - rect.top).max(0) as u32,
            });
        }
        1
    }

    let mut result = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(callback),
            &mut result as *mut Vec<MonitorInfo> as LPARAM,
        );
    }
    result
}

#[cfg(not(windows))]
pub fn monitors() -> Vec<MonitorInfo> {
    Vec::new()
}

#[cfg(windows)]
pub fn inject_input(input: &crate::desktop::DesktopInput) -> Result<()> {
    use std::mem::size_of;

    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
            MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
            MOUSEINPUT,
        },
        WindowsAndMessaging::SetCursorPos,
    };

    match input.input_type.as_str() {
        "mouse_move" => {
            if let (Some(x), Some(y)) = (input.x, input.y) {
                if unsafe { SetCursorPos(x, y) } == 0 {
                    anyhow::bail!("SetCursorPos failed");
                }
            }
        }
        "mouse_click" => {
            let flags = match (input.button.unwrap_or(0), input.pressed.unwrap_or(false)) {
                (0, true) => MOUSEEVENTF_LEFTDOWN,
                (0, false) => MOUSEEVENTF_LEFTUP,
                (1, true) => MOUSEEVENTF_RIGHTDOWN,
                (1, false) => MOUSEEVENTF_RIGHTUP,
                _ => 0,
            };
            if flags == 0 {
                anyhow::bail!("unsupported mouse button");
            }
            let mut event = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dwFlags: flags,
                        ..Default::default()
                    },
                },
            };
            if unsafe { SendInput(1, &mut event, size_of::<INPUT>() as i32) } != 1 {
                anyhow::bail!("SendInput mouse failed");
            }
        }
        "key" => {
            let virtual_key = input
                .key
                .as_deref()
                .and_then(|key| key.parse::<u16>().ok())
                .ok_or_else(|| anyhow::anyhow!("keyboard event requires numeric virtual key"))?;
            let mut event = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: virtual_key,
                        dwFlags: if input.pressed.unwrap_or(false) {
                            0
                        } else {
                            KEYEVENTF_KEYUP
                        },
                        ..Default::default()
                    },
                },
            };
            if unsafe { SendInput(1, &mut event, size_of::<INPUT>() as i32) } != 1 {
                anyhow::bail!("SendInput keyboard failed");
            }
        }
        _ => anyhow::bail!("unsupported Windows input event"),
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn inject_input(_input: &crate::desktop::DesktopInput) -> Result<()> {
    anyhow::bail!("Windows input injection is unavailable on this platform")
}
