//! Bounded, opt-in file-transfer primitives for desktop sessions.
//!
//! A remote session never receives an arbitrary host path. Callers construct
//! a root from an operator-approved directory and all requests are resolved
//! relative to that root.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

use anyhow::Result;

pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub directory: bool,
    pub size: u64,
}

pub struct FileTransferRoot {
    root: PathBuf,
}

impl FileTransferRoot {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().canonicalize()?;
        if !root.is_dir() {
            anyhow::bail!("file-transfer root is not a directory");
        }
        Ok(Self { root })
    }

    pub fn list(&self, relative: &str) -> Result<Vec<FileEntry>> {
        let directory = self.resolve(relative)?;
        if !directory.is_dir() {
            anyhow::bail!("requested file list path is not a directory");
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            entries.push(FileEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                directory: metadata.is_dir(),
                size: metadata.len(),
            });
        }
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(entries)
    }

    pub fn read_chunk(&self, relative: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
        let mut file = File::open(self.resolve(relative)?)?;
        let length = length.min(MAX_CHUNK_BYTES);
        file.seek(SeekFrom::Start(offset))?;
        let mut data = vec![0_u8; length];
        let read = file.read(&mut data)?;
        data.truncate(read);
        Ok(data)
    }

    pub fn write_chunk(
        &self,
        relative: &str,
        offset: u64,
        data: &[u8],
        finished: bool,
    ) -> Result<()> {
        if data.len() > MAX_CHUNK_BYTES {
            anyhow::bail!("file-transfer chunk is too large");
        }
        let path = self.resolve_for_write(relative)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(data)?;
        if finished {
            file.flush()?;
        }
        Ok(())
    }

    fn resolve(&self, relative: &str) -> Result<PathBuf> {
        let candidate = self.validate_relative(relative)?;
        let canonical = candidate.canonicalize()?;
        if !canonical.starts_with(&self.root) {
            anyhow::bail!("file-transfer path escapes approved root");
        }
        Ok(canonical)
    }

    fn resolve_for_write(&self, relative: &str) -> Result<PathBuf> {
        let candidate = self.validate_relative(relative)?;
        let mut existing_parent = candidate
            .parent()
            .ok_or_else(|| anyhow::anyhow!("file-transfer path has no parent"))?;
        while !existing_parent.exists() {
            existing_parent = existing_parent
                .parent()
                .ok_or_else(|| anyhow::anyhow!("file-transfer parent is invalid"))?;
        }
        let canonical_parent = existing_parent.canonicalize()?;
        if !canonical_parent.starts_with(&self.root) {
            anyhow::bail!("file-transfer path escapes approved root");
        }
        Ok(candidate)
    }

    fn validate_relative(&self, relative: &str) -> Result<PathBuf> {
        let path = Path::new(relative);
        if path.as_os_str().is_empty() || path.is_absolute() {
            anyhow::bail!("file-transfer path must be relative");
        }
        if path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            anyhow::bail!("file-transfer path contains a forbidden component");
        }
        Ok(self.root.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_and_absolute_paths() {
        let root = tempfile::tempdir().unwrap();
        let transfer = FileTransferRoot::new(root.path()).unwrap();
        assert!(transfer.list("../").is_err());
        assert!(transfer.list("C:\\Windows").is_err());
    }

    #[test]
    fn writes_and_reads_bounded_chunks() {
        let root = tempfile::tempdir().unwrap();
        let transfer = FileTransferRoot::new(root.path()).unwrap();
        transfer
            .write_chunk("folder/file.txt", 0, b"hello", true)
            .unwrap();
        assert_eq!(
            transfer.read_chunk("folder/file.txt", 0, 32).unwrap(),
            b"hello"
        );
    }
}
