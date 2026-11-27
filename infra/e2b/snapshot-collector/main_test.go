package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestHostMaintenanceLockSerializesIndependentJournalFiles(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(directory, "host.lock")
	first, err := acquireCollectorLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	for _, name := range []string{"first.jsonl", "other.jsonl"} {
		journal, err := openJournal(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		journal.Close()
		if second, err := acquireCollectorLock(lockPath); err == nil {
			second.Close()
			t.Fatal("independent journal bypassed the host maintenance lock")
		}
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	retry, err := acquireCollectorLock(lockPath)
	if err != nil {
		t.Fatal("completed invocation did not release maintenance lock:", err)
	}
	retry.Close()
}

func TestJournalRejectsNonregularAndSharedPaths(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(directory, "fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	if file, err := openJournal(fifo); err == nil {
		file.Close()
		t.Fatal("FIFO accepted as journal")
	}
	shared := filepath.Join(directory, "shared")
	if err := os.WriteFile(shared, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(directory, "linked")
	if err := os.Link(shared, linked); err != nil {
		t.Fatal(err)
	}
	if file, err := openJournal(linked); err == nil {
		file.Close()
		t.Fatal("shared hard link accepted as journal")
	}
	valid := filepath.Join(directory, "journal.jsonl")
	file, err := openJournal(valid)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("new journal was not private", err)
	}
}

func validCleanupConfig() cleanupConfig {
	return cleanupConfig{
		SchemaVersion:       1,
		Project:             "launchpad-e2b-test",
		StoragePath:         "/var/lib/launchpad/templates",
		BuildCachePath:      "/var/lib/launchpad/build-cache",
		JournalPath:         hostCollectorJournalPath,
		OrchestratorAddress: "127.0.0.1:5008",
		MinimumAgeSeconds:   60,
	}
}

func encodeCleanupConfig(t *testing.T, config cleanupConfig) []byte {
	t.Helper()
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDecodeConfigAcceptsExplicitSeparatedHostConfiguration(t *testing.T) {
	for _, age := range []int64{60, 365 * 24 * 60 * 60} {
		config := validCleanupConfig()
		config.MinimumAgeSeconds = age
		// Prefixes alone do not make paths overlap.
		config.BuildCachePath = config.StoragePath + "-cache"
		data := append(encodeCleanupConfig(t, config), []byte("\n\t ")...)
		got, err := decodeConfig(bytes.NewReader(data))
		if err != nil || !reflect.DeepEqual(got, config) {
			t.Fatalf("valid configuration = %+v, %v", got, err)
		}
	}
}

func TestDecodeConfigRejectsUnsafeHostConfiguration(t *testing.T) {
	tests := map[string]func(*cleanupConfig){
		"missing version": func(c *cleanupConfig) { c.SchemaVersion = 0 },
		"future version":  func(c *cleanupConfig) { c.SchemaVersion = 2 },
		"missing project": func(c *cleanupConfig) { c.Project = "" },
		"project option":  func(c *cleanupConfig) { c.Project = "--all" },
		"project escape":  func(c *cleanupConfig) { c.Project = "../other" },
		"project newline": func(c *cleanupConfig) { c.Project = "other\nproject" },
		"project too long": func(c *cleanupConfig) {
			c.Project = strings.Repeat("a", 64)
		},
		"relative storage":       func(c *cleanupConfig) { c.StoragePath = "templates" },
		"filesystem root":        func(c *cleanupConfig) { c.StoragePath = "/" },
		"unclean storage":        func(c *cleanupConfig) { c.StoragePath = "/var/lib/../templates" },
		"storage trailing slash": func(c *cleanupConfig) { c.StoragePath += "/" },
		"relative cache":         func(c *cleanupConfig) { c.BuildCachePath = "cache" },
		"alternate journal":      func(c *cleanupConfig) { c.JournalPath = "/var/log/launchpad/collection.jsonl" },
		"unclean journal":        func(c *cleanupConfig) { c.JournalPath = "/var/log/./collect" },
		"path newline":           func(c *cleanupConfig) { c.JournalPath += "\n" },
		"path nul":               func(c *cleanupConfig) { c.BuildCachePath += "\x00" },
		"same storage cache":     func(c *cleanupConfig) { c.BuildCachePath = c.StoragePath },
		"cache inside storage":   func(c *cleanupConfig) { c.BuildCachePath = c.StoragePath + "/cache" },
		"storage inside cache":   func(c *cleanupConfig) { c.StoragePath = c.BuildCachePath + "/templates" },
		"journal equals storage": func(c *cleanupConfig) {
			c.JournalPath = c.StoragePath
		},
		"journal inside storage": func(c *cleanupConfig) {
			c.JournalPath = c.StoragePath + "/collection.jsonl"
		},
		"journal inside cache": func(c *cleanupConfig) {
			c.JournalPath = c.BuildCachePath + "/collection.jsonl"
		},
		"journal contains storage": func(c *cleanupConfig) { c.JournalPath = "/var/lib/launchpad" },
		"journal contains cache": func(c *cleanupConfig) {
			c.JournalPath = "/var/cache"
			c.BuildCachePath = "/var/cache/launchpad"
		},
		"missing minimum age": func(c *cleanupConfig) { c.MinimumAgeSeconds = 0 },
		"young minimum age":   func(c *cleanupConfig) { c.MinimumAgeSeconds = 59 },
		"negative minimum age": func(c *cleanupConfig) {
			c.MinimumAgeSeconds = -1
		},
		"too old minimum age": func(c *cleanupConfig) { c.MinimumAgeSeconds = 365*24*60*60 + 1 },
		"remote orchestrator": func(c *cleanupConfig) { c.OrchestratorAddress = "192.0.2.1:5008" },
		"wildcard orchestrator": func(c *cleanupConfig) {
			c.OrchestratorAddress = "0.0.0.0:5008"
		},
		"loopback hostname": func(c *cleanupConfig) { c.OrchestratorAddress = "localhost:5008" },
		"other port":        func(c *cleanupConfig) { c.OrchestratorAddress = "127.0.0.1:5009" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			config := validCleanupConfig()
			mutate(&config)
			if _, err := decodeConfig(bytes.NewReader(encodeCleanupConfig(t, config))); err == nil {
				t.Fatal("unsafe configuration accepted")
			}
		})
	}
}

func TestDecodeConfigRejectsUnknownMalformedAndTrailingInput(t *testing.T) {
	valid := string(encodeCleanupConfig(t, validCleanupConfig()))
	tests := map[string]string{
		"unknown field":                   strings.TrimSuffix(valid, "}") + `,"allowBusy":true}`,
		"trailing object":                 valid + `{}`,
		"trailing garbage":                valid + `garbage`,
		"wrong type":                      strings.Replace(valid, `"minimumAgeSeconds":60`, `"minimumAgeSeconds":"60"`, 1),
		"array":                           `[` + valid + `]`,
		"null":                            `null`,
		"empty":                           "",
		"truncated":                       strings.TrimSuffix(valid, "}"),
		"trailing data beyond size limit": valid + strings.Repeat(" ", 64<<10) + `{}`,
		"oversized whitespace":            valid + strings.Repeat(" ", 64<<10),
	}
	for name, data := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeConfig(strings.NewReader(data)); err == nil {
				t.Fatal("non-strict JSON input accepted")
			}
		})
	}
}
