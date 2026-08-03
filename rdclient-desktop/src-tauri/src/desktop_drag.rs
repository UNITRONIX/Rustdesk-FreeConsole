//! Native OLE file drag-out (remote → local Explorer drop).
//!
//! After Cliprdr has materialised remote files into a temp directory, start a
//! real Windows drag via shell `IDataObject` + `SHDoDragDrop` on the UI thread
//! (ReleaseCapture first) so the cursor can leave the WebView window.

use std::path::PathBuf;
use std::sync::mpsc;

#[cfg(windows)]
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{Runtime, WebviewWindow};

#[cfg(windows)]
use windows::core::{Interface, HRESULT, HSTRING};
#[cfg(windows)]
use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, HWND, S_FALSE};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IDataObject, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
#[cfg(windows)]
use windows::Win32::System::Ole::DROPEFFECT_COPY;
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, ReleaseCapture, VK_LBUTTON,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::Common::IObjectCollection;
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    BHID_DataObject, EnumerableObjectCollection, IShellItem, IShellItemArray,
    SHCreateItemFromParsingName, SHDoDragDrop,
};

#[cfg(windows)]
static DRAG_IN_PROGRESS: AtomicUsize = AtomicUsize::new(0);

/// True while the primary mouse button is held (local OS state).
#[cfg(windows)]
pub fn lbutton_down() -> bool {
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000 != 0 }
}

#[cfg(not(windows))]
pub fn lbutton_down() -> bool {
    false
}

#[cfg(windows)]
fn create_shell_data_object(paths: &[PathBuf]) -> Result<IDataObject, String> {
    unsafe {
        let collection: IObjectCollection = CoCreateInstance(
            &EnumerableObjectCollection,
            None,
            CLSCTX_INPROC_SERVER,
        )
        .map_err(|e| format!("EnumerableObjectCollection: {e}"))?;

        for path in paths {
            let item: IShellItem =
                SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None)
                    .map_err(|e| format!("SHCreateItemFromParsingName({}): {e}", path.display()))?;
            collection
                .AddObject(&item)
                .map_err(|e| format!("AddObject: {e}"))?;
        }

        let array: IShellItemArray = collection
            .cast()
            .map_err(|e| format!("IShellItemArray cast: {e}"))?;
        let data: IDataObject = array
            .BindToHandler(None, &BHID_DataObject)
            .map_err(|e| format!("BHID_DataObject: {e}"))?;
        Ok(data)
    }
}

/// Run on the UI thread that owns WebView mouse capture.
#[cfg(windows)]
fn start_drag_on_ui_thread(hwnd_raw: isize, paths: Vec<String>) -> Result<&'static str, String> {
    let paths: Vec<PathBuf> = paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();
    if paths.is_empty() {
        return Err("no existing paths to drag".into());
    }
    if !lbutton_down() {
        return Err("left mouse button is not down".into());
    }
    if DRAG_IN_PROGRESS
        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("a drag is already in progress".into());
    }

    let result = (|| -> Result<&'static str, String> {
        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if init.is_err() && init != HRESULT(S_FALSE.0) {
                return Err(format!("CoInitializeEx: {init:?}"));
            }
            // Free WebView2 mouse capture so the OLE drag can leave the window.
            let _ = ReleaseCapture();
        }

        let data_obj = create_shell_data_object(&paths)?;
        let hwnd = if hwnd_raw != 0 {
            HWND(hwnd_raw as *mut std::ffi::c_void)
        } else {
            HWND::default()
        };
        let effect = unsafe { SHDoDragDrop(hwnd, &data_obj, None, DROPEFFECT_COPY) };

        unsafe {
            CoUninitialize();
        }

        match effect {
            Ok(_) => Ok("drop"),
            Err(e) if e.code() == DRAGDROP_S_DROP => Ok("drop"),
            Err(e) if e.code() == DRAGDROP_S_CANCEL => Ok("cancel"),
            Err(e) => Err(format!("SHDoDragDrop failed: {e}")),
        }
    })();

    DRAG_IN_PROGRESS.store(0, Ordering::SeqCst);
    result
}

#[cfg(not(windows))]
fn start_drag_on_ui_thread(_hwnd_raw: isize, _paths: Vec<String>) -> Result<&'static str, String> {
    Err("OLE file drag-out is only supported on Windows".into())
}

#[tauri::command]
pub fn desktop_clipboard_lbutton_down() -> bool {
    lbutton_down()
}

/// Start an OLE file drag on the UI thread (required so ReleaseCapture + mouse
/// tracking work; a worker-thread drag left the cursor trapped in the WebView).
#[tauri::command]
pub async fn desktop_clipboard_start_drag<R: Runtime>(
    window: WebviewWindow<R>,
    paths: Vec<String>,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel();

    #[cfg(windows)]
    let hwnd_raw: isize = window
        .hwnd()
        .map(|h| h.0 as isize)
        .unwrap_or(0);
    #[cfg(not(windows))]
    let hwnd_raw: isize = 0;

    window
        .run_on_main_thread(move || {
            let result = start_drag_on_ui_thread(hwnd_raw, paths).map(|s| s.to_string());
            let _ = tx.send(result);
        })
        .map_err(|e| format!("run_on_main_thread: {e}"))?;

    // SHDoDragDrop pumps messages on the UI thread until drop/cancel.
    rx.recv()
        .map_err(|e| format!("drag result channel: {e}"))?
}
