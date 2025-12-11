package fbhttp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jellydator/ttlcache/v3"
	"github.com/spf13/afero"

	"github.com/filebrowser/filebrowser/v2/blacklist"
	"github.com/filebrowser/filebrowser/v2/files"
	"github.com/filebrowser/filebrowser/v2/rules"
)

const maxUploadWait = 3 * time.Minute

// UploadInfo stores information about an active upload
type UploadInfo struct {
	Length   int64             `json:"length"`
	Checksum map[string]string `json:"checksum,omitempty"` // algorithm -> hash
}

// Tracks active uploads along with their respective upload lengths and checksums
var activeUploads = initActiveUploads()

func initActiveUploads() *ttlcache.Cache[string, string] {
	cache := ttlcache.New[string, string]()
	cache.OnEviction(func(_ context.Context, reason ttlcache.EvictionReason, item *ttlcache.Item[string, string]) {
		if reason == ttlcache.EvictionReasonExpired {
			fmt.Printf("deleting incomplete upload file: \"%s\"", item.Key())
			os.Remove(item.Key())
		}
	})
	go cache.Start()

	return cache
}

func registerUpload(filePath string, fileSize int64, checksum map[string]string) {
	info := UploadInfo{
		Length:   fileSize,
		Checksum: checksum,
	}
	data, err := json.Marshal(info)
	if err != nil {
		// Fallback to storing only size if JSON marshaling fails
		data = []byte(fmt.Sprintf(`{"length":%d}`, fileSize))
	}
	activeUploads.Set(filePath, string(data), maxUploadWait)
}

func completeUpload(filePath string) {
	activeUploads.Delete(filePath)
}

func getActiveUploadInfo(filePath string) (*UploadInfo, error) {
	item := activeUploads.Get(filePath)
	if item == nil {
		return nil, fmt.Errorf("no active upload found for the given path")
	}

	var info UploadInfo
	if err := json.Unmarshal([]byte(item.Value()), &info); err != nil {
		// Fallback: try to parse as just a number (backward compatibility)
		if length, err := strconv.ParseInt(item.Value(), 10, 64); err == nil {
			return &UploadInfo{Length: length}, nil
		}
		return nil, fmt.Errorf("failed to parse upload info: %w", err)
	}

	return &info, nil
}

func getActiveUploadLength(filePath string) (int64, error) {
	info, err := getActiveUploadInfo(filePath)
	if err != nil {
		return 0, err
	}
	return info.Length, nil
}

func keepUploadActive(filePath string) func() {
	stop := make(chan bool)

	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				activeUploads.Touch(filePath)
			}
		}
	}()

	return func() {
		close(stop)
	}
}

func tusPostHandler() handleFunc {
	return withUser(func(w http.ResponseWriter, r *http.Request, d *data) (int, error) {
		if !d.user.Perm.Create || !d.Check(r.URL.Path) {
			return http.StatusForbidden, nil
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
		fileExistedBefore := file != nil // Track if file existed before OpenFile
		switch {
		case errors.Is(err, afero.ErrFileNotFound):
			dirPath := filepath.Dir(r.URL.Path)
			if _, statErr := d.user.Fs.Stat(dirPath); os.IsNotExist(statErr) {
				if mkdirErr := d.user.Fs.MkdirAll(dirPath, d.settings.DirMode); mkdirErr != nil {
					return http.StatusInternalServerError, err
				}
			}
		case err != nil:
			return errToStatus(err), err
		}

		fileFlags := os.O_CREATE | os.O_WRONLY

		// if file exists
		if file != nil {
			if file.IsDir {
				return http.StatusBadRequest, fmt.Errorf("cannot upload to a directory %s", file.RealPath())
			}

			// Existing files will remain untouched unless explicitly instructed to override
			if r.URL.Query().Get("override") != "true" {
				return http.StatusConflict, nil
			}

			// Permission for overwriting the file
			if !d.user.Perm.Modify {
				return http.StatusForbidden, nil
			}

			fileFlags |= os.O_TRUNC
		}

		openFile, err := d.user.Fs.OpenFile(r.URL.Path, fileFlags, d.settings.FileMode)
		if err != nil {
			return errToStatus(err), err
		}
		defer openFile.Close()

		file, err = files.NewFileInfo(&files.FileOptions{
			Fs:         d.user.Fs,
			Path:       r.URL.Path,
			Modify:     d.user.Perm.Modify,
			Expand:     false,
			ReadHeader: false,
			Checker:    d,
			Content:    false,
		})
		if err != nil {
			// Clean up file only if it was just created (didn't exist before)
			if !fileExistedBefore {
				_ = d.user.Fs.RemoveAll(r.URL.Path)
			}
			return errToStatus(err), err
		}

		uploadLength, err := getUploadLength(r)
		if err != nil {
			// Clean up file only if it was just created (didn't exist before)
			if !fileExistedBefore {
				_ = d.user.Fs.RemoveAll(r.URL.Path)
			}
			return http.StatusBadRequest, fmt.Errorf("invalid upload length: %w", err)
		}

		// Parse checksum from header (required for integrity verification)
		checksums := parseChecksumHeader(r)

		// Require checksum for file integrity verification
		if len(checksums) == 0 {
			// Clean up file only if it was just created (didn't exist before)
			if !fileExistedBefore {
				_ = d.user.Fs.RemoveAll(r.URL.Path)
			}
			return http.StatusBadRequest, fmt.Errorf("Upload-Checksum header is required for file integrity verification")
		}

		// Enables the user to utilize the PATCH endpoint for uploading file data
		registerUpload(file.RealPath(), uploadLength, checksums)

		path, err := url.JoinPath("/", d.server.BaseURL, "/api/tus", r.URL.Path)
		if err != nil {
			// Clean up file and unregister upload if path join fails
			// Only remove file if it was just created (didn't exist before)
			completeUpload(file.RealPath())
			if !fileExistedBefore {
				_ = d.user.Fs.RemoveAll(r.URL.Path)
			}
			return http.StatusBadRequest, fmt.Errorf("invalid path: %w", err)
		}

		w.Header().Set("Location", path)
		return http.StatusCreated, nil
	})
}

func tusHeadHandler() handleFunc {
	return withUser(func(w http.ResponseWriter, r *http.Request, d *data) (int, error) {
		w.Header().Set("Cache-Control", "no-store")
		if !d.user.Perm.Create || !d.Check(r.URL.Path) {
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

		uploadLength, err := getActiveUploadLength(file.RealPath())
		if err != nil {
			return http.StatusNotFound, err
		}

		w.Header().Set("Upload-Offset", strconv.FormatInt(file.Size, 10))
		w.Header().Set("Upload-Length", strconv.FormatInt(uploadLength, 10))

		return http.StatusOK, nil
	})
}

func tusPatchHandler() handleFunc {
	return withUser(func(w http.ResponseWriter, r *http.Request, d *data) (int, error) {
		if !d.user.Perm.Create || !d.Check(r.URL.Path) {
			return http.StatusForbidden, nil
		}
		if r.Header.Get("Content-Type") != "application/offset+octet-stream" {
			return http.StatusUnsupportedMediaType, nil
		}

		uploadOffset, err := getUploadOffset(r)
		if err != nil {
			return http.StatusBadRequest, fmt.Errorf("invalid upload offset")
		}

		file, err := files.NewFileInfo(&files.FileOptions{
			Fs:         d.user.Fs,
			Path:       r.URL.Path,
			Modify:     d.user.Perm.Modify,
			Expand:     false,
			ReadHeader: d.server.TypeDetectionByHeader,
			Checker:    d,
		})

		switch {
		case errors.Is(err, afero.ErrFileNotFound):
			return http.StatusNotFound, nil
		case err != nil:
			return errToStatus(err), err
		}

		uploadLength, err := getActiveUploadLength(file.RealPath())
		if err != nil {
			return http.StatusNotFound, err
		}

		// Prevent the upload from being evicted during the transfer
		stop := keepUploadActive(file.RealPath())
		defer stop()

		switch {
		case file.IsDir:
			return http.StatusBadRequest, fmt.Errorf("cannot upload to a directory %s", file.RealPath())
		case file.Size != uploadOffset:
			return http.StatusConflict, fmt.Errorf(
				"%s file size doesn't match the provided offset: %d",
				file.RealPath(),
				uploadOffset,
			)
		}

		openFile, err := d.user.Fs.OpenFile(r.URL.Path, os.O_WRONLY|os.O_APPEND, d.settings.FileMode)
		if err != nil {
			return http.StatusInternalServerError, fmt.Errorf("could not open file: %w", err)
		}
		defer openFile.Close()

		_, err = openFile.Seek(uploadOffset, 0)
		if err != nil {
			return http.StatusInternalServerError, fmt.Errorf("could not seek file: %w", err)
		}

		defer r.Body.Close()
		bytesWritten, err := io.Copy(openFile, r.Body)
		if err != nil {
			return http.StatusInternalServerError, fmt.Errorf("could not write to file: %w", err)
		}

		// Sync file to ensure data is written to disk
		if syncFile, ok := openFile.(interface{ Sync() error }); ok {
			if err := syncFile.Sync(); err != nil {
				return http.StatusInternalServerError, fmt.Errorf("could not sync file: %w", err)
			}
		}

		// Close the file before verification to ensure all data is flushed
		openFile.Close()

		newOffset := uploadOffset + bytesWritten
		w.Header().Set("Upload-Offset", strconv.FormatInt(newOffset, 10))

		if newOffset >= uploadLength {
			// Verify file integrity before completing upload (required)
			uploadInfo, err := getActiveUploadInfo(file.RealPath())
			if err != nil {
				completeUpload(file.RealPath())
				_ = d.user.Fs.RemoveAll(r.URL.Path)
				return http.StatusBadRequest, fmt.Errorf("failed to get upload info: %w", err)
			}

			// Require checksum for file integrity verification
			if len(uploadInfo.Checksum) == 0 {
				completeUpload(file.RealPath())
				_ = d.user.Fs.RemoveAll(r.URL.Path)
				return http.StatusBadRequest, fmt.Errorf("checksum is required for file integrity verification")
			}

			// Use r.URL.Path (relative path) instead of file.RealPath() (absolute path)
			// because NewFileInfo expects a path relative to the filesystem root
			if verifyErr := verifyUploadIntegrity(d.user.Fs, r.URL.Path, uploadInfo.Length, uploadInfo.Checksum, d); verifyErr != nil {
				completeUpload(file.RealPath())
				_ = d.user.Fs.RemoveAll(r.URL.Path)
				return http.StatusBadRequest, fmt.Errorf("upload integrity check failed: %w", verifyErr)
			}

			completeUpload(file.RealPath())
			_ = d.RunHook(func() error { return nil }, "upload", r.URL.Path, "", d.user)
		}

		return http.StatusNoContent, nil
	})
}

func tusDeleteHandler() handleFunc {
	return withUser(func(_ http.ResponseWriter, r *http.Request, d *data) (int, error) {
		if r.URL.Path == "/" || !d.user.Perm.Create {
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

		_, err = getActiveUploadLength(file.RealPath())
		if err != nil {
			return http.StatusNotFound, err
		}

		err = d.user.Fs.RemoveAll(r.URL.Path)
		if err != nil {
			return errToStatus(err), err
		}

		completeUpload(file.RealPath())

		return http.StatusNoContent, nil
	})
}

func getUploadLength(r *http.Request) (int64, error) {
	uploadOffset, err := strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid upload length: %w", err)
	}
	return uploadOffset, nil
}

func getUploadOffset(r *http.Request) (int64, error) {
	uploadOffset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid upload offset: %w", err)
	}
	return uploadOffset, nil
}

// verifyUploadIntegrity verifies file size and optional checksums
func verifyUploadIntegrity(fs afero.Fs, filePath string, expectedSize int64, expectedChecksums map[string]string, checker rules.Checker) error {
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

		// Log hash verification result with timestamp
		if actualHashTrimmed == expectedHashTrimmed {
			log.Printf("[Upload Integrity] File hash verification passed: path=%s, size=%d, algorithm=%s, hash=%s", filePath, file.Size, algo, actualHashTrimmed)
		} else {
			log.Printf("[Upload Integrity] File hash verification failed: path=%s, size=%d, algorithm=%s, expected=%s, actual=%s", filePath, file.Size, algo, expectedHashTrimmed, actualHashTrimmed)
			return fmt.Errorf("%s checksum mismatch: expected %s, got %s", algo, expectedHashTrimmed, actualHashTrimmed)
		}
	}

	return nil
}

// parseChecksumHeader parses checksum from request headers
// Supports TUS format: "Upload-Checksum: <algorithm> <hash>"
// Example: "Upload-Checksum: sha256 abc123def456..."
func parseChecksumHeader(r *http.Request) map[string]string {
	checksumHeader := r.Header.Get("Upload-Checksum")
	if checksumHeader == "" {
		return nil
	}

	checksums := make(map[string]string)

	// Parse format: "algorithm hash" (TUS standard format)
	// Find first space to separate algorithm and hash
	spaceIdx := -1
	for i, c := range checksumHeader {
		if c == ' ' {
			spaceIdx = i
			break
		}
	}

	if spaceIdx > 0 && spaceIdx < len(checksumHeader)-1 {
		algo := strings.ToLower(strings.TrimSpace(checksumHeader[:spaceIdx]))
		hash := strings.TrimSpace(checksumHeader[spaceIdx+1:])
		// Validate algorithm
		if algo == "md5" || algo == "sha1" || algo == "sha256" || algo == "sha512" {
			checksums[algo] = hash
		}
	} else {
		// No space found, try to detect algorithm by hash length
		hash := checksumHeader
		switch len(hash) {
		case 32:
			checksums["md5"] = hash
		case 40:
			checksums["sha1"] = hash
		case 64:
			checksums["sha256"] = hash
		case 128:
			checksums["sha512"] = hash
		}
	}

	return checksums
}
