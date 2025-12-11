package fbhttp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/disk"
	"github.com/spf13/afero"

	"github.com/filebrowser/filebrowser/v2/blacklist"
	fberrors "github.com/filebrowser/filebrowser/v2/errors"
	"github.com/filebrowser/filebrowser/v2/files"
	"github.com/filebrowser/filebrowser/v2/fileutils"
	"github.com/filebrowser/filebrowser/v2/rules"
)

var resourceGetHandler = withUser(func(w http.ResponseWriter, r *http.Request, d *data) (int, error) {
	file, err := files.NewFileInfo(&files.FileOptions{
		Fs:         d.user.Fs,
		Path:       r.URL.Path,
		Modify:     d.user.Perm.Modify,
		Expand:     true,
		ReadHeader: d.server.TypeDetectionByHeader,
		Checker:    d,
		Content:    true,
	})
	if err != nil {
		return errToStatus(err), err
	}

	if file.IsDir {
		file.Sorting = d.user.Sorting
		file.ApplySort()
		return renderJSON(w, r, file)
	}

	if checksum := r.URL.Query().Get("checksum"); checksum != "" {
		err := file.Checksum(checksum)
		if errors.Is(err, fberrors.ErrInvalidOption) {
			return http.StatusBadRequest, nil
		} else if err != nil {
			return http.StatusInternalServerError, err
		}

		// do not waste bandwidth if we just want the checksum
		file.Content = ""
	}

	return renderJSON(w, r, file)
})

func resourceDeleteHandler(fileCache FileCache) handleFunc {
	return withUser(func(_ http.ResponseWriter, r *http.Request, d *data) (int, error) {
		if r.URL.Path == "/" || !d.user.Perm.Delete {
			return http.StatusForbidden, nil
		}

		file, err := files.NewFileInfo(&files.FileOptions{
			Fs:         d.user.Fs,
			Path:       r.URL.Path,
			Modify:     d.user.Perm.Modify,
			Expand:     false,
			ReadHeader: d.server.TypeDetectionByHeader,
			Checker:    d,
		})
		if err != nil {
			return errToStatus(err), err
		}

		err = d.store.Share.DeleteWithPathPrefix(file.Path)
		if err != nil {
			log.Printf("WARNING: Error(s) occurred while deleting associated shares with file: %s", err)
		}

		// delete thumbnails
		err = delThumbs(r.Context(), fileCache, file)
		if err != nil {
			return errToStatus(err), err
		}

		err = d.RunHook(func() error {
			return d.user.Fs.RemoveAll(r.URL.Path)
		}, "delete", r.URL.Path, "", d.user)

		if err != nil {
			return errToStatus(err), err
		}

		return http.StatusNoContent, nil
	})
}

func resourcePostHandler(fileCache FileCache) handleFunc {
	return withUser(func(w http.ResponseWriter, r *http.Request, d *data) (int, error) {
		if !d.user.Perm.Create || !d.Check(r.URL.Path) {
			return http.StatusForbidden, nil
		}

		// Directories creation on POST.
		if strings.HasSuffix(r.URL.Path, "/") {
			err := d.user.Fs.MkdirAll(r.URL.Path, d.settings.DirMode)
			return errToStatus(err), err
		}

		// Check file blacklist before processing upload
		blacklistChecker := blacklist.NewChecker()
		if err := blacklistChecker.Check(r.URL.Path); err != nil {
			return http.StatusForbidden, err
		}

		file, err := files.NewFileInfo(&files.FileOptions{
			Fs:         d.user.Fs,
			Path:       r.URL.Path,
			Modify:     d.user.Perm.Modify,
			Expand:     false,
			ReadHeader: d.server.TypeDetectionByHeader,
			Checker:    d,
		})
		if err == nil {
			if r.URL.Query().Get("override") != "true" {
				return http.StatusConflict, nil
			}

			// Permission for overwriting the file
			if !d.user.Perm.Modify {
				return http.StatusForbidden, nil
			}

			err = delThumbs(r.Context(), fileCache, file)
			if err != nil {
				return errToStatus(err), err
			}
		}

		// Parse expected size and checksum from headers (required for integrity verification)
		var expectedSize int64 = -1
		if sizeStr := r.Header.Get("X-Expected-Size"); sizeStr != "" {
			if size, parseErr := strconv.ParseInt(sizeStr, 10, 64); parseErr == nil {
				expectedSize = size
			}
		}

		expectedChecksums := parseChecksumHeaderForPost(r)

		// Require checksum for file integrity verification
		if len(expectedChecksums) == 0 {
			return http.StatusBadRequest, fmt.Errorf("checksum header is required for file integrity verification")
		}

		// Require expected size for file integrity verification
		if expectedSize < 0 {
			return http.StatusBadRequest, fmt.Errorf("X-Expected-Size header is required for file integrity verification")
		}

		err = d.RunHook(func() error {
			info, writeErr := writeFile(d.user.Fs, r.URL.Path, r.Body, d.settings.FileMode, d.settings.DirMode)
			if writeErr != nil {
				return writeErr
			}

			// Verify file integrity (checksum and size are required)
			if verifyErr := verifyUploadIntegrityForPost(d.user.Fs, r.URL.Path, expectedSize, expectedChecksums, d); verifyErr != nil {
				// Remove file if integrity check fails
				_ = d.user.Fs.RemoveAll(r.URL.Path)
				return fmt.Errorf("upload integrity check failed: %w", verifyErr)
			}

			etag := fmt.Sprintf(`"%x%x"`, info.ModTime().UnixNano(), info.Size())
			w.Header().Set("ETag", etag)
			return nil
		}, "upload", r.URL.Path, "", d.user)

		if err != nil {
			_ = d.user.Fs.RemoveAll(r.URL.Path)
		}

		return errToStatus(err), err
	})
}

var resourcePutHandler = withUser(func(w http.ResponseWriter, r *http.Request, d *data) (int, error) {
	if !d.user.Perm.Modify || !d.Check(r.URL.Path) {
		return http.StatusForbidden, nil
	}

	// Only allow PUT for files.
	if strings.HasSuffix(r.URL.Path, "/") {
		return http.StatusMethodNotAllowed, nil
	}

	exists, err := afero.Exists(d.user.Fs, r.URL.Path)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if !exists {
		return http.StatusNotFound, nil
	}

	err = d.RunHook(func() error {
		info, writeErr := writeFile(d.user.Fs, r.URL.Path, r.Body, d.settings.FileMode, d.settings.DirMode)
		if writeErr != nil {
			return writeErr
		}

		etag := fmt.Sprintf(`"%x%x"`, info.ModTime().UnixNano(), info.Size())
		w.Header().Set("ETag", etag)
		return nil
	}, "save", r.URL.Path, "", d.user)

	return errToStatus(err), err
})

func resourcePatchHandler(fileCache FileCache) handleFunc {
	return withUser(func(_ http.ResponseWriter, r *http.Request, d *data) (int, error) {
		src := r.URL.Path
		dst := r.URL.Query().Get("destination")
		action := r.URL.Query().Get("action")
		dst, err := url.QueryUnescape(dst)
		if !d.Check(src) || !d.Check(dst) {
			return http.StatusForbidden, nil
		}
		if err != nil {
			return errToStatus(err), err
		}
		if dst == "/" || src == "/" {
			return http.StatusForbidden, nil
		}

		err = checkParent(src, dst)
		if err != nil {
			return http.StatusBadRequest, err
		}

		override := r.URL.Query().Get("override") == "true"
		rename := r.URL.Query().Get("rename") == "true"
		if !override && !rename {
			if _, err = d.user.Fs.Stat(dst); err == nil {
				return http.StatusConflict, nil
			}
		}
		if rename {
			dst = addVersionSuffix(dst, d.user.Fs)
		}

		// Permission for overwriting the file
		if override && !d.user.Perm.Modify {
			return http.StatusForbidden, nil
		}

		err = d.RunHook(func() error {
			return patchAction(r.Context(), action, src, dst, d, fileCache)
		}, action, src, dst, d.user)

		return errToStatus(err), err
	})
}

func checkParent(src, dst string) error {
	rel, err := filepath.Rel(src, dst)
	if err != nil {
		return err
	}

	rel = filepath.ToSlash(rel)
	if !strings.HasPrefix(rel, "../") && rel != ".." && rel != "." {
		return fberrors.ErrSourceIsParent
	}

	return nil
}

func addVersionSuffix(source string, afs afero.Fs) string {
	counter := 1
	dir, name := path.Split(source)
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)

	for {
		if _, err := afs.Stat(source); err != nil {
			break
		}
		renamed := fmt.Sprintf("%s(%d)%s", base, counter, ext)
		source = path.Join(dir, renamed)
		counter++
	}

	return source
}

func writeFile(afs afero.Fs, dst string, in io.Reader, fileMode, dirMode fs.FileMode) (os.FileInfo, error) {
	dir, _ := path.Split(dst)
	err := afs.MkdirAll(dir, dirMode)
	if err != nil {
		return nil, err
	}

	file, err := afs.OpenFile(dst, os.O_RDWR|os.O_CREATE|os.O_TRUNC, fileMode)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	_, err = io.Copy(file, in)
	if err != nil {
		return nil, err
	}

	// Sync file to ensure data is written to disk
	if syncFile, ok := file.(interface{ Sync() error }); ok {
		if err := syncFile.Sync(); err != nil {
			return nil, fmt.Errorf("failed to sync file: %w", err)
		}
	}

	// Gets the info about the file.
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}

	return info, nil
}

// verifyUploadIntegrityForPost verifies file size and optional checksums for POST uploads
func verifyUploadIntegrityForPost(fs afero.Fs, filePath string, expectedSize int64, expectedChecksums map[string]string, checker rules.Checker) error {
	file, err := files.NewFileInfo(&files.FileOptions{
		Fs:         fs,
		Path:       filePath,
		Modify:     false,
		Expand:     false,
		ReadHeader: false,
		Checker:    checker,
		Content:    false,
	})
	if err != nil {
		return fmt.Errorf("failed to get file info: %w", err)
	}

	// Verify file size
	if file.Size != expectedSize {
		return fmt.Errorf("file size mismatch: expected %d, got %d", expectedSize, file.Size)
	}

	// Verify checksums (required)
	if len(expectedChecksums) == 0 {
		return fmt.Errorf("checksum is required for file integrity verification")
	}

	for algo, expectedHash := range expectedChecksums {
		if err := file.Checksum(algo); err != nil {
			return fmt.Errorf("failed to compute %s checksum: %w", algo, err)
		}

		actualHash, ok := file.Checksums[algo]
		if !ok {
			return fmt.Errorf("checksum algorithm %s not supported", algo)
		}

		// Remove any whitespace for comparison
		expectedHashTrimmed := strings.TrimSpace(expectedHash)
		actualHashTrimmed := strings.TrimSpace(actualHash)

		// Log hash verification result
		if actualHashTrimmed == expectedHashTrimmed {
			log.Printf("[Upload Integrity] File hash verification passed: path=%s, size=%d, algorithm=%s, hash=%s", filePath, file.Size, algo, actualHashTrimmed)
		} else {
			log.Printf("[Upload Integrity] File hash verification failed: path=%s, size=%d, algorithm=%s, expected=%s, actual=%s", filePath, file.Size, algo, expectedHashTrimmed, actualHashTrimmed)
			return fmt.Errorf("%s checksum mismatch: expected %s, got %s", algo, expectedHashTrimmed, actualHashTrimmed)
		}
	}

	return nil
}

// parseChecksumHeaderForPost parses checksum from request headers for POST uploads
// Supports format: "X-Upload-Checksum: <algorithm>:<hash>" or "X-Upload-Checksum-<algorithm>: <hash>"
func parseChecksumHeaderForPost(r *http.Request) map[string]string {
	checksums := make(map[string]string)

	// Try format: "X-Upload-Checksum: algorithm:hash"
	if checksumHeader := r.Header.Get("X-Upload-Checksum"); checksumHeader != "" {
		parts := strings.SplitN(checksumHeader, ":", 2)
		if len(parts) == 2 {
			algo := strings.TrimSpace(parts[0])
			hash := strings.TrimSpace(parts[1])
			if algo == "md5" || algo == "sha1" || algo == "sha256" || algo == "sha512" {
				checksums[algo] = hash
			}
		}
	}

	// Try format: "X-Upload-Checksum-<algorithm>: <hash>"
	for _, algo := range []string{"md5", "sha1", "sha256", "sha512"} {
		if hash := r.Header.Get("X-Upload-Checksum-" + algo); hash != "" {
			checksums[algo] = strings.TrimSpace(hash)
		}
	}

	return checksums
}

func delThumbs(ctx context.Context, fileCache FileCache, file *files.FileInfo) error {
	for _, previewSizeName := range PreviewSizeNames() {
		size, _ := ParsePreviewSize(previewSizeName)
		if err := fileCache.Delete(ctx, previewCacheKey(file, size)); err != nil {
			return err
		}
	}

	return nil
}

func patchAction(ctx context.Context, action, src, dst string, d *data, fileCache FileCache) error {
	switch action {
	case "copy":
		if !d.user.Perm.Create {
			return fberrors.ErrPermissionDenied
		}

		return fileutils.Copy(d.user.Fs, src, dst, d.settings.FileMode, d.settings.DirMode)
	case "rename":
		if !d.user.Perm.Rename {
			return fberrors.ErrPermissionDenied
		}
		src = path.Clean("/" + src)
		dst = path.Clean("/" + dst)

		file, err := files.NewFileInfo(&files.FileOptions{
			Fs:         d.user.Fs,
			Path:       src,
			Modify:     d.user.Perm.Modify,
			Expand:     false,
			ReadHeader: false,
			Checker:    d,
		})
		if err != nil {
			return err
		}

		// delete thumbnails
		err = delThumbs(ctx, fileCache, file)
		if err != nil {
			return err
		}

		return fileutils.MoveFile(d.user.Fs, src, dst, d.settings.FileMode, d.settings.DirMode)
	default:
		return fmt.Errorf("unsupported action %s: %w", action, fberrors.ErrInvalidRequestParams)
	}
}

type DiskUsageResponse struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

var diskUsage = withUser(func(w http.ResponseWriter, r *http.Request, d *data) (int, error) {
	file, err := files.NewFileInfo(&files.FileOptions{
		Fs:         d.user.Fs,
		Path:       r.URL.Path,
		Modify:     d.user.Perm.Modify,
		Expand:     false,
		ReadHeader: false,
		Checker:    d,
		Content:    false,
	})
	if err != nil {
		return errToStatus(err), err
	}
	fPath := file.RealPath()
	if !file.IsDir {
		return renderJSON(w, r, &DiskUsageResponse{
			Total: 0,
			Used:  0,
		})
	}

	usage, err := disk.UsageWithContext(r.Context(), fPath)
	if err != nil {
		return errToStatus(err), err
	}
	return renderJSON(w, r, &DiskUsageResponse{
		Total: usage.Total,
		Used:  usage.Used,
	})
})
