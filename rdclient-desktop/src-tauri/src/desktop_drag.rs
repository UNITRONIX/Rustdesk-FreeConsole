//! Native OLE file drag-out (remote → local Explorer drop).
//!
//! After Cliprdr has materialised remote files into a temp directory, start a
//! real Windows drag via shell `IDataObject` + `SHDoDragDrop` so the operator can
//! release over the local Desktop / Explorer while still holding LBUTTON.

use std::path::PathBuf;

#[cfg(windows)]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(windows)]
use windows::core::{Interface, HRESULT, HSTRING};
#[cfg(windows)]
use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, S_FALSE};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IDataObject, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
#[cfg(windows)]
use windows::Win32::System::Ole::DROPEFFECT_COPY;
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
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

/// Blocking OLE drag. Call from a worker thread with COM apartment init.
#[cfg(windows)]
pub fn start_drag_blocking(paths: Vec<String>) -> Result<&'static str, String> {
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
            // S_FALSE means COM already initialised on this thread — still OK.
            if init.is_err() && init != HRESULT(S_FALSE.0) {
                return Err(format!("CoInitializeEx: {init:?}"));
            }
        }

        let data_obj = create_shell_data_object(&paths)?;
        // NULL drop source → shell default (tracks LBUTTON / Escape).
        let effect = unsafe { SHDoDragDrop(None, &data_obj, None, DROPEFFECT_COPY) };

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
pub fn start_drag_blocking(_paths: Vec<String>) -> Result<&'static str, String> {
    Err("OLE file drag-out is only supported on Windows".into())
}

#[tauri::command]
pub fn desktop_clipboard_lbutton_down() -> bool {
    lbutton_down()
}

#[tauri::command]
pub async fn desktop_clipboard_start_drag(paths: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || start_drag_blocking(paths).map(|s| s.to_string()))
        .await
        .map_err(|e| format!("drag task join: {e}"))?
}
