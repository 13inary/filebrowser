package blacklist

import (
	"path/filepath"
	"strings"
)

// DefaultBlacklistedExtensions contains the default list of blacklisted file extensions
var DefaultBlacklistedExtensions = []string{
	".exe",
}

// Checker provides file blacklist checking functionality
type Checker struct {
	blacklistedExtensions map[string]bool
}

// NewChecker creates a new blacklist checker with default blacklisted extensions
func NewChecker() *Checker {
	return NewCheckerWithExtensions(DefaultBlacklistedExtensions)
}

// NewCheckerWithExtensions creates a new blacklist checker with custom blacklisted extensions
func NewCheckerWithExtensions(extensions []string) *Checker {
	extMap := make(map[string]bool)
	for _, ext := range extensions {
		// Normalize extension: convert to lowercase and ensure it starts with a dot
		ext = strings.ToLower(ext)
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		extMap[ext] = true
	}
	return &Checker{
		blacklistedExtensions: extMap,
	}
}

// IsBlacklisted checks if a file path is blacklisted based on its extension
// Returns true if the file is blacklisted, false otherwise
func (c *Checker) IsBlacklisted(filePath string) bool {
	ext := strings.ToLower(filepath.Ext(filePath))
	return c.blacklistedExtensions[ext]
}

// Check returns an error if the file is blacklisted, nil otherwise
func (c *Checker) Check(filePath string) error {
	if c.IsBlacklisted(filePath) {
		ext := filepath.Ext(filePath)
		return &BlacklistError{
			FilePath:  filePath,
			Extension: ext,
		}
	}
	return nil
}

// BlacklistError represents an error when a file is blacklisted
type BlacklistError struct {
	FilePath  string
	Extension string
}

func (e *BlacklistError) Error() string {
	return "file type is not allowed: " + e.Extension
}

