//! Native filesystem bridge for RdClient desktop file transfer.
//!
//! The panel's JS file-transfer module uses browser File objects and the File System
//! Access API. WebView2 does not expose directory pickers reliably, so these commands
//! back LocalFiles + RDFileTransfer with OS dialogs and path-based reads.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

pub struct DesktopFileStore {
    inner: Mutex<HashMap<String, PathBuf>>,
}

impl Default for DesktopFileStore {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFileInfo {
    pub handle: String,
    pub name: String,
    pub size: u64,
    pub modified_time: u64,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_time: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFolderInfo {
    pub path: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSaveResult {
    pub saved: bool,
    pub path: Option<String>,
}

fn store_error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn new_handle() -> String {
    format!(
        "df{}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

fn modified_time(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn validate_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required".into());
    }
    if trimmed.contains('\0') {
        return Err("Invalid path".into());
    }
    let p = PathBuf::from(trimmed);
    let canonical = fs::canonicalize(&p).map_err(store_error)?;
    Ok(canonical)
}

fn register_path(store: &DesktopFileStore, path: PathBuf) -> Result<DesktopFileInfo, String> {
    if !path.is_file() {
        return Err("Not a file".into());
    }
    let meta = fs::metadata(&path).map_err(store_error)?;
    let handle = new_handle();
    let info = DesktopFileInfo {
        name: file_name(&path),
        size: meta.len(),
        modified_time: modified_time(&path),
        path: path.to_string_lossy().into_owned(),
        handle: handle.clone(),
    };
    store
        .inner
        .lock()
        .map_err(|_| "File store lock poisoned".to_string())?
        .insert(handle, path);
    Ok(info)
}

#[tauri::command]
pub async fn desktop_pick_files(store: State<'_, DesktopFileStore>) -> Result<Vec<DesktopFileInfo>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_files())
        .await
        .map_err(|e| e.to_string())?;

    let Some(paths) = picked else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for path in paths {
        match register_path(&store, path) {
            Ok(info) => out.push(info),
            Err(e) => eprintln!("[desktop_files] pick skip: {e}"),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn desktop_open_file(
    store: State<'_, DesktopFileStore>,
    path: String,
) -> Result<DesktopFileInfo, String> {
    let validated = validate_path(&path)?;
    register_path(&store, validated)
}

#[tauri::command]
pub fn desktop_open_paths(
    store: State<'_, DesktopFileStore>,
    paths: Vec<String>,
) -> Result<Vec<DesktopFileInfo>, String> {
    let mut out = Vec::new();
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        match validate_path(trimmed).and_then(|p| register_path(&store, p)) {
            Ok(info) => out.push(info),
            Err(e) => eprintln!("[desktop_files] open path skip: {e}"),
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn desktop_read_file_chunk(
    store: State<'_, DesktopFileStore>,
    handle: String,
    offset: u64,
    length: u32,
) -> Result<Vec<u8>, String> {
    let len = length.min(512 * 1024) as usize;
    let path = store
        .inner
        .lock()
        .map_err(|_| "File store lock poisoned".to_string())?
        .get(&handle)
        .cloned()
        .ok_or_else(|| "Unknown file handle".to_string())?;

    let mut file = File::open(&path).map_err(store_error)?;
    file.seek(SeekFrom::Start(offset)).map_err(store_error)?;
    let mut buf = vec![0u8; len];
    let read = file.read(&mut buf).map_err(store_error)?;
    buf.truncate(read);
    Ok(buf)
}

#[tauri::command]
pub fn desktop_release_file_handles(
    store: State<'_, DesktopFileStore>,
    handles: Vec<String>,
) -> Result<(), String> {
    let mut guard = store
        .inner
        .lock()
        .map_err(|_| "File store lock poisoned".to_string())?;
    for h in handles {
        guard.remove(&h);
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_pick_folder() -> Result<Option<DesktopFolderInfo>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|e| e.to_string())?;

    Ok(picked.map(|path| DesktopFolderInfo {
        name: file_name(&path),
        path: path.to_string_lossy().into_owned(),
    }))
}

#[tauri::command]
pub fn desktop_list_directory(path: String) -> Result<Vec<DesktopDirEntry>, String> {
    let dir = validate_path(&path)?;
    if !dir.is_dir() {
        return Err("Not a directory".into());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(store_error)? {
        let entry = entry.map_err(store_error)?;
        let p = entry.path();
        let name = file_name(&p);
        if name.is_empty() {
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata().map_err(store_error)?;
        entries.push(DesktopDirEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
            modified_time: modified_time(&p),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
pub async fn desktop_save_download(
    file_name: String,
    data: Vec<u8>,
) -> Result<DesktopSaveResult, String> {
    let safe_name = Path::new(file_name.trim())
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && !n.contains('\0'))
        .unwrap_or("download.bin")
        .to_string();

    let dialog_name = safe_name.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_file_name(&dialog_name)
            .save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(mut target) = picked else {
        return Ok(DesktopSaveResult {
            saved: false,
            path: None,
        });
    };

    if target.extension().is_none() {
        if let Some(ext) = Path::new(&safe_name).extension() {
            target.set_extension(ext);
        }
    }

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(store_error)?;
        }
    }

    fs::write(&target, &data).map_err(store_error)?;
    Ok(DesktopSaveResult {
        saved: true,
        path: Some(target.to_string_lossy().into_owned()),
    })
}

/// Reject paths with parent-dir components before canonicalize (symlink-safe listing).
#[allow(dead_code)]
fn path_has_parent_hop(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
}
