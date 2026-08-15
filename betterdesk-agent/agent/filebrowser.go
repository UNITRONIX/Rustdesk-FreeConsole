package agent

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// FileEntry represents a single directory entry returned to the gateway.
type FileEntry struct {
	Name     string `json:"name"`
	IsDir    bool   `json:"is_dir"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"` // unix ms
	Mode     string `json:"mode"`     // e.g. "drwxr-xr-x"
}

func pathWithin(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." ||
		(rel != ".." &&
			!strings.HasPrefix(rel, ".."+string(filepath.Separator)) &&
			!filepath.IsAbs(rel))
}

// safePath resolves a user-supplied path relative to root and prevents
// traversal through both .. components and symlinks. The nearest existing
// ancestor is checked so writes to new files cannot use a symlinked parent.
func safePath(root, userPath string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("invalid root: %w", err)
	}
	absRoot = filepath.Clean(absRoot)

	realRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		return "", fmt.Errorf("invalid root: %w", err)
	}
	realRoot, err = filepath.Abs(realRoot)
	if err != nil {
		return "", fmt.Errorf("invalid resolved root: %w", err)
	}

	// Treat leading separators as the historical root-relative notation, but
	// preserve .. components so an escape is rejected instead of normalized
	// back inside the root. Drive-qualified Windows paths are never relative.
	if filepath.VolumeName(userPath) != "" {
		return "", fmt.Errorf("absolute path denied")
	}
	relativeInput := strings.TrimLeft(userPath, `/\`)
	absPath := filepath.Clean(filepath.Join(absRoot, relativeInput))
	if !pathWithin(absRoot, absPath) {
		return "", fmt.Errorf("path traversal denied")
	}

	// Resolve the existing portion of the path. This catches symlink escapes
	// for reads, deletes, and writes whose destination does not exist yet.
	checkPath := absPath
	for {
		_, statErr := os.Lstat(checkPath)
		if statErr == nil {
			realPath, resolveErr := filepath.EvalSymlinks(checkPath)
			if resolveErr != nil {
				return "", fmt.Errorf("cannot resolve path: %w", resolveErr)
			}
			realPath, resolveErr = filepath.Abs(realPath)
			if resolveErr != nil || !pathWithin(realRoot, realPath) {
				return "", fmt.Errorf("path escapes file root")
			}
			break
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return "", fmt.Errorf("cannot inspect path: %w", statErr)
		}
		parent := filepath.Dir(checkPath)
		if parent == checkPath {
			break
		}
		checkPath = parent
	}

	return absPath, nil
}

// ListDirectory lists the contents of a directory.
func ListDirectory(root, path string) ([]FileEntry, error) {
	dir, err := safePath(root, path)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}

	result := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		info, infoErr := e.Info()
		if infoErr != nil {
			continue
		}
		result = append(result, FileEntry{
			Name:     e.Name(),
			IsDir:    e.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime().UnixMilli(),
			Mode:     info.Mode().String(),
		})
	}
	return result, nil
}

// ReadFileChunk reads a segment of a file. Returns the data, total file
// size, whether EOF has been reached, and any error.
func ReadFileChunk(root, path string, offset, length int64) ([]byte, int64, bool, error) {
	fp, err := safePath(root, path)
	if err != nil {
		return nil, 0, false, err
	}

	f, err := os.Open(fp)
	if err != nil {
		return nil, 0, false, fmt.Errorf("open: %w", err)
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, 0, false, err
	}
	if stat.IsDir() {
		return nil, 0, false, fmt.Errorf("cannot read directory")
	}

	totalSize := stat.Size()
	if length <= 0 || length > 1024*1024 {
		length = 64 * 1024 // 64 KB default chunk
	}
	if offset >= totalSize {
		return nil, totalSize, true, nil
	}

	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, totalSize, false, err
	}

	buf := make([]byte, length)
	n, readErr := f.Read(buf)
	done := readErr == io.EOF || offset+int64(n) >= totalSize
	if readErr != nil && readErr != io.EOF {
		return nil, totalSize, false, readErr
	}
	return buf[:n], totalSize, done, nil
}

// WriteFileChunk writes data at the given offset in a file. Creates the
// file (and parent directories) if it does not exist.
func WriteFileChunk(root, path string, offset int64, data []byte) (int64, error) {
	fp, err := safePath(root, path)
	if err != nil {
		return 0, err
	}

	// Ensure parent directory exists
	if mkErr := os.MkdirAll(filepath.Dir(fp), 0755); mkErr != nil {
		return 0, mkErr
	}

	flag := os.O_CREATE | os.O_WRONLY
	f, err := os.OpenFile(fp, flag, 0644)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}

	n, err := f.Write(data)
	return int64(n), err
}

// DeletePath removes a file or empty directory.
func DeletePath(root, path string) error {
	fp, err := safePath(root, path)
	if err != nil {
		return err
	}

	// Extra safety: never delete the root itself
	absRoot, _ := filepath.Abs(root)
	if fp == absRoot {
		return fmt.Errorf("cannot delete root directory")
	}

	return os.Remove(fp)
}
