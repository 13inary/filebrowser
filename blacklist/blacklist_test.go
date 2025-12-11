package blacklist

import (
	"testing"
)

func TestNewChecker(t *testing.T) {
	checker := NewChecker()
	if checker == nil {
		t.Fatal("NewChecker() returned nil")
	}
}

func TestIsBlacklisted(t *testing.T) {
	checker := NewChecker()

	tests := []struct {
		filePath   string
		blacklisted bool
	}{
		{"test.exe", true},
		{"test.EXE", true},
		{"test.ExE", true},
		{"test.txt", false},
		{"test.jpg", false},
		{"test.pdf", false},
		{"path/to/file.exe", true},
		{"path/to/file.txt", false},
		{"file", false},
		{".exe", true}, // File named .exe should be blocked
	}

	for _, tt := range tests {
		t.Run(tt.filePath, func(t *testing.T) {
			result := checker.IsBlacklisted(tt.filePath)
			if result != tt.blacklisted {
				t.Errorf("IsBlacklisted(%q) = %v, want %v", tt.filePath, result, tt.blacklisted)
			}
		})
	}
}

func TestCheck(t *testing.T) {
	checker := NewChecker()

	tests := []struct {
		filePath string
		wantErr  bool
	}{
		{"test.exe", true},
		{"test.EXE", true},
		{"test.txt", false},
		{"test.jpg", false},
	}

	for _, tt := range tests {
		t.Run(tt.filePath, func(t *testing.T) {
			err := checker.Check(tt.filePath)
			if (err != nil) != tt.wantErr {
				t.Errorf("Check(%q) error = %v, wantErr %v", tt.filePath, err, tt.wantErr)
			}
			if err != nil {
				blacklistErr, ok := err.(*BlacklistError)
				if !ok {
					t.Errorf("Check(%q) returned error type %T, want *BlacklistError", tt.filePath, err)
				} else if blacklistErr.Extension != ".exe" && blacklistErr.Extension != ".EXE" {
					t.Errorf("Check(%q) returned error with extension %q, want .exe", tt.filePath, blacklistErr.Extension)
				}
			}
		})
	}
}

func TestNewCheckerWithExtensions(t *testing.T) {
	extensions := []string{".exe", ".bat", "sh"} // Test with and without dots
	checker := NewCheckerWithExtensions(extensions)

	if checker == nil {
		t.Fatal("NewCheckerWithExtensions() returned nil")
	}

	tests := []struct {
		filePath   string
		blacklisted bool
	}{
		{"test.exe", true},
		{"test.bat", true},
		{"test.sh", true},
		{"test.txt", false},
	}

	for _, tt := range tests {
		t.Run(tt.filePath, func(t *testing.T) {
			result := checker.IsBlacklisted(tt.filePath)
			if result != tt.blacklisted {
				t.Errorf("IsBlacklisted(%q) = %v, want %v", tt.filePath, result, tt.blacklisted)
			}
		})
	}
}

func TestBlacklistError(t *testing.T) {
	err := &BlacklistError{
		FilePath:  "/path/to/file.exe",
		Extension: ".exe",
	}

	expectedMsg := "file type is not allowed: .exe"
	if err.Error() != expectedMsg {
		t.Errorf("BlacklistError.Error() = %q, want %q", err.Error(), expectedMsg)
	}
}

