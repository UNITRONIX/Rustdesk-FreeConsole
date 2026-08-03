//! Windows clipboard file bridge for Cliprdr (Explorer copy ↔ remote paste).
//!
//! Outbound: reads CF_HDROP, builds MS-RDPECLIP FILEGROUPDESCRIPTORW PDUs, and
//! serves FileContentsRequest responses from cached local paths.
//!
//! Inbound: parses peer FILEGROUPDESCRIPTORW, writes files into a temp directory,
//! then places CF_HDROP on the local clipboard so Explorer paste works.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
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
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
/// FILETIME (100ns since 1601-01-01) ↔ Unix epoch delta.
const LDAP_EPOCH_DELTA: u64 = 116444736000000000;
const FILEDESCRIPTORW_SIZE: usize = 592;

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
    /// Files received from remote Cliprdr — suppress outbound echo briefly via JS.
    Received,
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
            busy: false,
            paths: Vec::new(),
        }
    }
}

struct ReceiveEntry {
    relative: String,
    size: u64,
    is_dir: bool,
    path: PathBuf,
}

struct ReceiveSession {
    root: PathBuf,
    entries: Vec<ReceiveEntry>,
    top_paths: Vec<PathBuf>,
}

static CLIP_CACHE: Mutex<ClipFileCache> = Mutex::new(ClipFileCache {
    source: CacheSource::None,
    top_paths: Vec::new(),
    sigs: Vec::new(),
    file_list: Vec::new(),
    files_pdu: Vec::new(),
    signature: String::new(),
});

static RECEIVE_SESSION: Mutex<Option<ReceiveSession>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardSyncResult {
    pub has_files: bool,
    pub signature: String,
    /// True when OpenClipboard failed (busy). Callers must not clear file state.
    pub busy: bool,
    /// Top-level paths when this result comes from an inbound receive commit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardFormatNames {
    pub file_descriptor_format_id: i32,
    pub file_descriptor_format_name: String,
    pub file_contents_format_id: i32,
    pub file_contents_format_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardReceiveFile {
    pub index: i32,
    pub relative_path: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClipboardReceiveBeginResult {
    pub files: Vec<DesktopClipboardReceiveFile>,
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
            sig.mtime
                .map(|t| t
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_nanos())
                    .unwrap_or(0))
                .unwrap_or(0),
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

    let mut buf = Vec::with_capacity(FILEDESCRIPTORW_SIZE);
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
        buf.resize(FILEDESCRIPTORW_SIZE, 0);
    } else {
        buf.truncate(FILEDESCRIPTORW_SIZE);
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
    let mut data = Vec::with_capacity(4 + FILEDESCRIPTORW_SIZE * file_list.len());
    put_u32_le(&mut data, file_list.len() as u32);
    for entry in file_list {
        data.extend_from_slice(&file_descriptor_bin(entry));
    }
    data
}

fn read_u32_le(data: &[u8], off: usize) -> Result<u32, String> {
    let bytes: [u8; 4] = data
        .get(off..off + 4)
        .ok_or_else(|| "truncated FILEDESCRIPTORW".to_string())?
        .try_into()
        .map_err(|_| "truncated FILEDESCRIPTORW".to_string())?;
    Ok(u32::from_le_bytes(bytes))
}

fn decode_utf16le_z(data: &[u8]) -> String {
    let mut units = Vec::with_capacity(data.len() / 2);
    let mut i = 0;
    while i + 1 < data.len() {
        let u = u16::from_le_bytes([data[i], data[i + 1]]);
        if u == 0 {
            break;
        }
        units.push(u);
        i += 2;
    }
    String::from_utf16_lossy(&units)
}

/// Parse MS-RDPECLIP FILEGROUPDESCRIPTORW PDU into (relative_path, size, is_dir).
fn parse_files_pdu(data: &[u8]) -> Result<Vec<(String, u64, bool)>, String> {
    if data.len() < 4 {
        return Err("empty file descriptor PDU".into());
    }
    let count = read_u32_le(data, 0)? as usize;
    let need = 4usize.saturating_add(count.saturating_mul(FILEDESCRIPTORW_SIZE));
    if data.len() < need {
        return Err(format!(
            "truncated file descriptor PDU: have {} need {}",
            data.len(),
            need
        ));
    }

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let off = 4 + i * FILEDESCRIPTORW_SIZE;
        let desc = &data[off..off + FILEDESCRIPTORW_SIZE];
        let flags = read_u32_le(desc, 0)?;
        let attrs = read_u32_le(desc, 36)?;
        let size_high = read_u32_le(desc, 64)?;
        let size_low = read_u32_le(desc, 68)?;
        let size = if flags & FLAGS_FD_SIZE != 0 {
            ((size_high as u64) << 32) | (size_low as u64)
        } else {
            0
        };
        let is_dir = if flags & FLAGS_FD_ATTRIBUTES != 0 {
            attrs & FILE_ATTRIBUTE_DIRECTORY != 0
        } else {
            false
        };
        let name = decode_utf16le_z(&desc[72..]);
        let relative = name.trim().replace('/', "\\");
        if relative.is_empty() {
            continue;
        }
        out.push((relative, size, is_dir));
    }
    Ok(out)
}

fn abort_receive_locked(slot: &mut Option<ReceiveSession>) {
    if let Some(session) = slot.take() {
        let _ = fs::remove_dir_all(&session.root);
    }
}

#[cfg(windows)]
enum ClipboardPathsRead {
    Busy,
    Empty,
    Paths(Vec<String>),
}

#[cfg(windows)]
fn read_clipboard_paths() -> ClipboardPathsRead {
    use windows::Win32::Foundation::{HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    const CF_HDROP: u32 = 15;

    unsafe {
        if OpenClipboard(HWND::default()).is_err() {
            return ClipboardPathsRead::Busy;
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
        match result {
            None => ClipboardPathsRead::Empty,
            Some(paths) if paths.is_empty() => ClipboardPathsRead::Empty,
            Some(paths) => ClipboardPathsRead::Paths(paths),
        }
    }
}

#[cfg(windows)]
fn write_clipboard_paths(paths: &[PathBuf]) -> Result<(), String> {
    use windows::Win32::Foundation::{HANDLE, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    const CF_HDROP: u32 = 15;
    const DROPFILES_SIZE: usize = 20;

    if paths.is_empty() {
        return Err("no paths to place on clipboard".into());
    }

    let mut path_units: Vec<u16> = Vec::new();
    for path in paths {
        for unit in path.to_string_lossy().encode_utf16() {
            path_units.push(unit);
        }
        path_units.push(0);
    }
    path_units.push(0);

    let path_bytes = path_units.len() * 2;
    let total = DROPFILES_SIZE + path_bytes;

    unsafe {
        OpenClipboard(HWND::default()).map_err(|e| format!("OpenClipboard: {e}"))?;
        if let Err(e) = EmptyClipboard() {
            let _ = CloseClipboard();
            return Err(format!("EmptyClipboard: {e}"));
        }

        let hglobal = match GlobalAlloc(GMEM_MOVEABLE, total) {
            Ok(h) => h,
            Err(e) => {
                let _ = CloseClipboard();
                return Err(format!("GlobalAlloc: {e}"));
            }
        };
        let locked = GlobalLock(hglobal);
        if locked.is_null() {
            let _ = CloseClipboard();
            return Err("GlobalLock failed".into());
        }

        let base = locked as *mut u8;
        // DROPFILES header
        let p_files = DROPFILES_SIZE as u32;
        std::ptr::copy_nonoverlapping(p_files.to_le_bytes().as_ptr(), base, 4);
        // pt.x, pt.y, fNC = 0
        std::ptr::write_bytes(base.add(4), 0, 12);
        // fWide = TRUE
        let f_wide: u32 = 1;
        std::ptr::copy_nonoverlapping(f_wide.to_le_bytes().as_ptr(), base.add(16), 4);
        std::ptr::copy_nonoverlapping(
            path_units.as_ptr() as *const u8,
            base.add(DROPFILES_SIZE),
            path_bytes,
        );

        let _ = GlobalUnlock(hglobal);
        if let Err(e) = SetClipboardData(CF_HDROP, HANDLE(hglobal.0)) {
            let _ = CloseClipboard();
            return Err(format!("SetClipboardData: {e}"));
        }
        CloseClipboard().map_err(|e| format!("CloseClipboard: {e}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
enum ClipboardPathsRead {
    Busy,
    Empty,
    Paths(Vec<String>),
}

#[cfg(not(windows))]
fn read_clipboard_paths() -> ClipboardPathsRead {
    ClipboardPathsRead::Empty
}

#[cfg(not(windows))]
fn write_clipboard_paths(_paths: &[PathBuf]) -> Result<(), String> {
    Err("CF_HDROP clipboard write is only supported on Windows".into())
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
                // Received files are on CF_HDROP after commit; if the OS clipboard
                // no longer has files, drop the cache like a normal Explorer clear.
                cache.clear();
            }
            CacheSource::Paths | CacheSource::Received | CacheSource::None => cache.clear(),
        }
        return Ok(DesktopClipboardSyncResult {
            has_files: false,
            signature: String::new(),
            busy: false,
            paths: Vec::new(),
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
    cache.signature = signature;

    Ok(cache.result())
}

fn sync_from_clipboard() -> Result<DesktopClipboardSyncResult, String> {
    match read_clipboard_paths() {
        ClipboardPathsRead::Busy => {
            let cache = CLIP_CACHE
                .lock()
                .map_err(|_| "Clipboard cache lock poisoned".to_string())?;
            Ok(DesktopClipboardSyncResult {
                has_files: !cache.files_pdu.is_empty(),
                signature: cache.signature.clone(),
                busy: true,
                paths: Vec::new(),
            })
        }
        ClipboardPathsRead::Empty => sync_from_paths(Vec::new(), CacheSource::Clipboard),
        ClipboardPathsRead::Paths(paths) => sync_from_paths(paths, CacheSource::Clipboard),
    }
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

    let offset = ((n_position_high as u32 as u64) << 32) | (n_position_low as u32 as u64);
    let length = cb_requested as u32 as u64;
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

/// Begin an inbound Cliprdr receive: parse FILEGROUPDESCRIPTORW and prepare temp files.
#[tauri::command]
pub fn desktop_clipboard_receive_begin(
    format_data: Vec<u8>,
) -> Result<DesktopClipboardReceiveBeginResult, String> {
    let parsed = parse_files_pdu(&format_data)?;
    if parsed.is_empty() {
        return Err("no files in descriptor PDU".into());
    }

    let mut slot = RECEIVE_SESSION
        .lock()
        .map_err(|_| "Receive session lock poisoned".to_string())?;
    abort_receive_locked(&mut slot);

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let root = std::env::temp_dir().join(format!("betterdesk-cliprdr-{stamp}"));
    fs::create_dir_all(&root).map_err(store_error)?;

    let mut top_seen = HashSet::new();
    let mut top_paths = Vec::new();
    let mut entries: Vec<ReceiveEntry> = Vec::with_capacity(parsed.len());

    // Materialize entry metadata in list-index order first.
    for (relative, size, is_dir) in parsed {
        let safe_rel = relative.trim_start_matches(['\\', '/']);
        if safe_rel.is_empty() || safe_rel.contains("..") {
            let _ = fs::remove_dir_all(&root);
            return Err(format!("unsafe relative path: {relative}"));
        }
        let path = root.join(Path::new(&safe_rel.replace('\\', "/")));
        let first = safe_rel.split(['\\', '/']).next().unwrap_or(safe_rel);
        if top_seen.insert(first.to_string()) {
            top_paths.push(root.join(first));
        }
        entries.push(ReceiveEntry {
            relative: safe_rel.replace('/', "\\"),
            size,
            is_dir,
            path,
        });
    }

    // Create directories/files shallowest-first so parents exist before children.
    let mut create_order: Vec<usize> = (0..entries.len()).collect();
    create_order.sort_by(|&a, &b| {
        let da = entries[a].relative.matches('\\').count();
        let db = entries[b].relative.matches('\\').count();
        da.cmp(&db)
            .then_with(|| entries[a].relative.cmp(&entries[b].relative))
    });

    for &idx in &create_order {
        let entry = &entries[idx];
        if let Some(parent) = entry.path.parent() {
            fs::create_dir_all(parent).map_err(store_error)?;
        }
        if entry.is_dir {
            fs::create_dir_all(&entry.path).map_err(store_error)?;
        } else {
            File::create(&entry.path).map_err(store_error)?;
        }
    }

    let files: Vec<DesktopClipboardReceiveFile> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| DesktopClipboardReceiveFile {
            index: i as i32,
            relative_path: e.relative.clone(),
            size: e.size,
            is_dir: e.is_dir,
        })
        .collect();

    *slot = Some(ReceiveSession {
        root,
        entries,
        top_paths,
    });

    Ok(DesktopClipboardReceiveBeginResult { files })
}

/// Append/write a chunk into a file started by `desktop_clipboard_receive_begin`.
#[tauri::command]
pub fn desktop_clipboard_receive_write(
    list_index: i32,
    offset: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    let slot = RECEIVE_SESSION
        .lock()
        .map_err(|_| "Receive session lock poisoned".to_string())?;
    let session = slot
        .as_ref()
        .ok_or_else(|| "no active clipboard receive session".to_string())?;
    let entry = session
        .entries
        .get(list_index as usize)
        .ok_or_else(|| format!("invalid receive index {list_index}"))?;
    if entry.is_dir {
        return Err("cannot write directory contents".into());
    }

    let mut file = OpenOptions::new()
        .write(true)
        .open(&entry.path)
        .map_err(store_error)?;
    file.seek(SeekFrom::Start(offset)).map_err(store_error)?;
    file.write_all(&data).map_err(store_error)?;
    Ok(())
}

/// Place received top-level paths on the local CF_HDROP clipboard.
#[tauri::command]
pub fn desktop_clipboard_receive_commit() -> Result<DesktopClipboardSyncResult, String> {
    let mut slot = RECEIVE_SESSION
        .lock()
        .map_err(|_| "Receive session lock poisoned".to_string())?;
    let session = slot
        .take()
        .ok_or_else(|| "no active clipboard receive session".to_string())?;

    // Keep temp files — CF_HDROP points at them until the user pastes / OS clears.
    write_clipboard_paths(&session.top_paths).map_err(|e| {
        let _ = fs::remove_dir_all(&session.root);
        e
    })?;

    let paths: Vec<String> = session
        .top_paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let mut result = sync_from_paths(paths.clone(), CacheSource::Received)?;
    result.paths = paths;
    Ok(result)
}

#[tauri::command]
pub fn desktop_clipboard_receive_abort() {
    if let Ok(mut slot) = RECEIVE_SESSION.lock() {
        abort_receive_locked(&mut slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_files_pdu_roundtrip_single_file() {
        let entry = LocalFileEntry {
            relative_root: PathBuf::from("C:\\tmp"),
            path: PathBuf::from("C:\\tmp\\hello.txt"),
            name: "hello.txt".into(),
            size: 42,
            last_write_time: UNIX_EPOCH,
            is_dir: false,
            read_only: false,
            hidden: false,
            perm: 0o644,
        };
        let pdu = build_files_pdu(&[entry]);
        let parsed = parse_files_pdu(&pdu).expect("parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0, "hello.txt");
        assert_eq!(parsed[0].1, 42);
        assert!(!parsed[0].2);
    }

    #[test]
    fn parse_files_pdu_directory_flag() {
        let entry = LocalFileEntry {
            relative_root: PathBuf::from("C:\\tmp"),
            path: PathBuf::from("C:\\tmp\\folder"),
            name: "folder".into(),
            size: 0,
            last_write_time: UNIX_EPOCH,
            is_dir: true,
            read_only: false,
            hidden: false,
            perm: 0o755,
        };
        let pdu = build_files_pdu(&[entry]);
        let parsed = parse_files_pdu(&pdu).expect("parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0, "folder");
        assert!(parsed[0].2);
    }
}
