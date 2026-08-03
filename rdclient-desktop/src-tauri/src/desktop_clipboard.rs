//! Windows clipboard file bridge for Cliprdr (Explorer copy → remote paste).
//!
//! Builds MS-RDPECLIP FILEGROUPDESCRIPTORW PDUs and serves FileContentsRequest
//! responses from cached local file paths (CF_HDROP).

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const FILEDESCRIPTOR_FORMAT_ID: i32 = 49334;
const FILECONTENTS_FORMAT_ID: i32 = 49267;
const FILEDESCRIPTORW_FORMAT_NAME: &str = "FileGroupDescriptorW";
const FILECONTENTS_FORMAT_NAME: &str = "FileContents";

const FLAGS_FD_ATTRIBUTES: u32 = 0x04;
const FLAGS_FD_SIZE: u32 = 0x40;
const FLAGS_FD_LAST_WRITE: u32 = 0x20;
const FLAGS_FD_PROGRESSUI: u32 = 0x4000;
const FLAGS_FD_UNIX_MODE: u32 = 0x08;
const LDAP_EPOCH_DELTA: u64 = 116444772610000000;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct FileSig {
    size: u64,
    mtime: Option<SystemTime>,
    is_dir: bool,
}

#[derive(Debug)]
struct LocalFileEntry {
    relative_root: PathBuf,
    path: PathBuf,
    name: String,
    size: u64,
    last_write_time: SystemTime,
    is_dir: bool,
    read_only: bool,
    hidden: bool,
    perm: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CacheSource {
    None,
    /// Explorer copy (CF_HDROP) — cleared when OS clipboard no longer holds files.
    Clipboard,
    /// Native drag-drop paths — must not be wiped by clipboard polling.
    Paths,
}

struct ClipFileCache {
    source: CacheSource,
    top_paths: Vec<String>,
    sigs: Vec<FileSig>,
    file_list: Vec<LocalFileEntry>,
    files_pdu: Vec<u8>,
    signature: String,
}

impl Default for ClipFileCache {
    fn default() -> Self {
        Self {
            source: CacheSource::None,
            top_paths: Vec::new(),
            sigs: Vec::new(),
            file_list: Vec::new(),
            files_pdu: Vec::new(),
            signature: String::new(),
        }
    }
}

impl ClipFileCache {
    fn clear(&mut self) {
        self.source = CacheSource::None;
        self.top_paths.clear();
        self.sigs.clear();
        self.file_list.clear();
        self.files_pdu.clear();
        self.signature.clear();
    }

    fn result(&self) -> DesktopClipboardSyncResult {
        DesktopClipboardSyncResult {
            has_files: !self.files_pdu.is_empty(),
            signature: self.signature.clone(),
        }
    }
}

static CLIP_CACHE: Mutex<ClipFileCache> = Mutex::new(ClipFileCache {
    source: CacheSource::None,
    top_paths: Vec::new(),
    sigs: Vec::new(),
    file_list: Vec::new(),
    files_pdu: Vec::new(),
    signature: String::new(),
});

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardSyncResult {
    pub has_files: bool,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardFormatNames {
    pub file_descriptor_format_id: i32,
    pub file_descriptor_format_name: String,
    pub file_contents_format_id: i32,
    pub file_contents_format_name: String,
}

fn store_error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn fingerprint(paths: &[String]) -> Vec<FileSig> {
    paths
        .iter()
        .map(|s| match fs::metadata(s) {
            Ok(mt) => FileSig {
                size: mt.len(),
                mtime: mt.modified().ok(),
                is_dir: mt.is_dir(),
            },
            Err(_) => FileSig::default(),
        })
        .collect()
}

fn make_signature(paths: &[String], sigs: &[FileSig]) -> String {
    let mut parts: Vec<String> = paths.to_vec();
    for sig in sigs {
        parts.push(format!(
            "{}:{}:{}",
            sig.size,
            sig.mtime.map(|t| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_nanos()).unwrap_or(0)).unwrap_or(0),
            sig.is_dir
        ));
    }
    parts.join("|")
}

fn put_u32_le(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn put_u64_le(buf: &mut Vec<u8>, v: u64) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn encode_utf16le_path(path: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(path.len() * 2 + 2);
    for unit in path.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

fn file_descriptor_bin(entry: &LocalFileEntry) -> Vec<u8> {
    let read_only_flag = if entry.read_only { 0x1 } else { 0 };
    let hidden_flag = if entry.hidden { 0x2 } else { 0 };
    let directory_flag = if entry.is_dir { 0x10 } else { 0 };
    let normal_flag = if !(entry.is_dir || entry.read_only || entry.hidden) {
        0x80
    } else {
        0
    };
    let file_attributes = read_only_flag | hidden_flag | directory_flag | normal_flag;

    let win32_time = entry
        .last_write_time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
        / 100
        + LDAP_EPOCH_DELTA;

    let size_high = (entry.size >> 32) as u32;
    let size_low = (entry.size & (u32::MAX as u64)) as u32;

    let rel = entry
        .path
        .strip_prefix(&entry.relative_root)
        .unwrap_or(&entry.path);
    let rel_str = rel.to_string_lossy().replace('/', "\\");
    let name = encode_utf16le_path(&rel_str);
    let name_len = name.len().min(520);

    let flags = FLAGS_FD_SIZE
        | FLAGS_FD_LAST_WRITE
        | FLAGS_FD_ATTRIBUTES
        | FLAGS_FD_PROGRESSUI
        | FLAGS_FD_UNIX_MODE;

    let mut buf = Vec::with_capacity(592);
    put_u32_le(&mut buf, flags);
    buf.extend_from_slice(&[0u8; 32]);
    put_u32_le(&mut buf, file_attributes);
    buf.extend_from_slice(&[0u8; 12]);
    put_u32_le(&mut buf, entry.perm);
    put_u64_le(&mut buf, win32_time);
    put_u32_le(&mut buf, size_high);
    put_u32_le(&mut buf, size_low);
    buf.extend_from_slice(&name[..name_len]);
    if name_len < 520 {
        buf.resize(592, 0);
    } else {
        buf.truncate(592);
    }
    buf
}

fn open_local_file(relative_root: &Path, path: &Path) -> Result<LocalFileEntry, String> {
    let meta = fs::metadata(path).map_err(store_error)?;
    let size = meta.len();
    let is_dir = meta.is_dir();
    #[cfg(windows)]
    let read_only = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x1 != 0
    };
    #[cfg(not(windows))]
    let read_only = meta.permissions().readonly();
    let hidden = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false);
    let last_write_time = meta.modified().unwrap_or(UNIX_EPOCH);
    #[cfg(unix)]
    let perm = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode()
    };
    #[cfg(not(unix))]
    let perm = if is_dir { 0o755 } else { 0o644 };

    Ok(LocalFileEntry {
        relative_root: relative_root.to_path_buf(),
        path: path.to_path_buf(),
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
        size,
        last_write_time,
        is_dir,
        read_only,
        hidden,
        perm,
    })
}

fn construct_file_list(paths: &[PathBuf]) -> Result<Vec<LocalFileEntry>, String> {
    fn walk(
        relative_root: &Path,
        path: &Path,
        out: &mut Vec<LocalFileEntry>,
        visited: &mut HashSet<PathBuf>,
    ) -> Result<(), String> {
        if visited.contains(path) {
            return Ok(());
        }
        visited.insert(path.to_path_buf());

        out.push(open_local_file(relative_root, path)?);
        let meta = fs::metadata(path).map_err(store_error)?;
        if !meta.is_dir() {
            return Ok(());
        }
        for entry in fs::read_dir(path).map_err(store_error)? {
            let entry = entry.map_err(store_error)?;
            walk(relative_root, &entry.path(), out, visited)?;
        }
        Ok(())
    }

    let Some(first) = paths.first() else {
        return Err("empty file list".into());
    };
    let relative_root = first
        .parent()
        .ok_or_else(|| "empty parent".to_string())?
        .to_path_buf();

    let mut out = Vec::new();
    let mut visited = HashSet::new();
    for path in paths {
        walk(&relative_root, path, &mut out, &mut visited)?;
    }
    Ok(out)
}

fn build_files_pdu(file_list: &[LocalFileEntry]) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 592 * file_list.len());
    put_u32_le(&mut data, file_list.len() as u32);
    for entry in file_list {
        data.extend_from_slice(&file_descriptor_bin(entry));
    }
    data
}

#[cfg(windows)]
fn read_clipboard_paths() -> Vec<String> {
    use windows::Win32::Foundation::{HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    const CF_HDROP: u32 = 15;

    unsafe {
        if OpenClipboard(HWND::default()).is_err() {
            return Vec::new();
        }

        let result = (|| -> Option<Vec<String>> {
            if IsClipboardFormatAvailable(CF_HDROP).is_err() {
                return None;
            }
            let handle = GetClipboardData(CF_HDROP).ok()?;
            let hglobal = HGLOBAL(handle.0);
            let locked = GlobalLock(hglobal);
            if locked.is_null() {
                return None;
            }

            let base = locked as *const u8;
            let p_files = u32::from_le_bytes([
                *base.add(0),
                *base.add(1),
                *base.add(2),
                *base.add(3),
            ]) as usize;
            let f_wide = *base.add(16) != 0;

            let mut paths = Vec::new();
            if f_wide {
                let mut ptr = base.add(p_files) as *const u16;
                loop {
                    let mut len = 0usize;
                    while *ptr.add(len) != 0 {
                        len += 1;
                        if len > 65536 {
                            break;
                        }
                    }
                    if len == 0 {
                        break;
                    }
                    let slice = std::slice::from_raw_parts(ptr, len);
                    paths.push(String::from_utf16_lossy(slice));
                    ptr = ptr.add(len + 1);
                }
            } else {
                let mut ptr = base.add(p_files);
                loop {
                    let mut len = 0usize;
                    while *ptr.add(len) != 0 {
                        len += 1;
                        if len > 65536 {
                            break;
                        }
                    }
                    if len == 0 {
                        break;
                    }
                    let slice = std::slice::from_raw_parts(ptr, len);
                    paths.push(String::from_utf8_lossy(slice).into_owned());
                    ptr = ptr.add(len + 1);
                }
            }

            let _ = GlobalUnlock(hglobal);
            Some(paths)
        })();

        let _ = CloseClipboard();
        result.unwrap_or_default()
    }
}

#[cfg(not(windows))]
fn read_clipboard_paths() -> Vec<String> {
    Vec::new()
}

fn sync_from_paths(paths: Vec<String>, source: CacheSource) -> Result<DesktopClipboardSyncResult, String> {
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();

    let mut cache = CLIP_CACHE
        .lock()
        .map_err(|_| "Clipboard cache lock poisoned".to_string())?;

    if paths.is_empty() {
        match source {
            CacheSource::Clipboard => {
                if cache.source == CacheSource::Paths && !cache.files_pdu.is_empty() {
                    return Ok(cache.result());
                }
                cache.clear();
            }
            CacheSource::Paths => cache.clear(),
            CacheSource::None => cache.clear(),
        }
        return Ok(DesktopClipboardSyncResult {
            has_files: false,
            signature: String::new(),
        });
    }

    let sigs = fingerprint(&paths);
    let signature = make_signature(&paths, &sigs);

    if cache.source == source
        && cache.top_paths == paths
        && cache.sigs == sigs
        && !sigs.iter().any(|s| s.is_dir)
    {
        return Ok(cache.result());
    }

    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    cache.file_list = construct_file_list(&path_bufs)?;
    cache.files_pdu = build_files_pdu(&cache.file_list);
    cache.source = source;
    cache.top_paths = paths;
    cache.sigs = sigs;
    cache.signature = signature.clone();

    Ok(cache.result())
}

fn sync_from_clipboard() -> Result<DesktopClipboardSyncResult, String> {
    sync_from_paths(read_clipboard_paths(), CacheSource::Clipboard)
}

#[tauri::command]
pub fn desktop_clipboard_sync() -> Result<DesktopClipboardSyncResult, String> {
    sync_from_clipboard()
}

#[tauri::command]
pub fn desktop_clipboard_sync_paths(
    paths: Vec<String>,
) -> Result<DesktopClipboardSyncResult, String> {
    sync_from_paths(paths, CacheSource::Paths)
}

#[tauri::command]
pub fn desktop_clipboard_format_data() -> Result<Vec<u8>, String> {
    let cache = CLIP_CACHE
        .lock()
        .map_err(|_| "Clipboard cache lock poisoned".to_string())?;
    Ok(cache.files_pdu.clone())
}

#[tauri::command]
pub fn desktop_clipboard_file_contents(
    list_index: i32,
    dw_flags: i32,
    n_position_low: i32,
    n_position_high: i32,
    cb_requested: i32,
) -> Result<Vec<u8>, String> {
    let cache = CLIP_CACHE
        .lock()
        .map_err(|_| "Clipboard cache lock poisoned".to_string())?;
    let idx = list_index as usize;
    let Some(entry) = cache.file_list.get(idx) else {
        return Err(format!("invalid file index {list_index}"));
    };
    if entry.is_dir {
        return Err("cannot read directory contents".into());
    }

    if dw_flags == 0x1 {
        return Ok(entry.size.to_le_bytes().to_vec());
    }
    if dw_flags != 0x2 {
        return Err(format!("unsupported dw_flags {dw_flags}"));
    }

    let offset = (n_position_high as u64) << 32 | (n_position_low as u64);
    let length = cb_requested as u64;
    if offset > entry.size {
        return Err("invalid read offset".into());
    }
    let read_size = if offset.saturating_add(length) > entry.size {
        entry.size - offset
    } else {
        length
    } as usize;

    let mut file = File::open(&entry.path).map_err(store_error)?;
    file.seek(SeekFrom::Start(offset)).map_err(store_error)?;
    let mut buf = vec![0u8; read_size];
    file.read_exact(&mut buf).map_err(store_error)?;
    Ok(buf)
}

#[tauri::command]
pub fn desktop_clipboard_clear() {
    if let Ok(mut cache) = CLIP_CACHE.lock() {
        cache.clear();
    }
}

#[tauri::command]
pub fn desktop_clipboard_format_names() -> DesktopClipboardFormatNames {
    DesktopClipboardFormatNames {
        file_descriptor_format_id: FILEDESCRIPTOR_FORMAT_ID,
        file_descriptor_format_name: FILEDESCRIPTORW_FORMAT_NAME.to_string(),
        file_contents_format_id: FILECONTENTS_FORMAT_ID,
        file_contents_format_name: FILECONTENTS_FORMAT_NAME.to_string(),
    }
}
