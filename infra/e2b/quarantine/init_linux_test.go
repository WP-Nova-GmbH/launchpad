//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func fixture(t *testing.T) (string, File) {
	t.Helper()
	root := t.TempDir()
	data := []byte("a retained native fact")
	path := filepath.Join(root, "native")
	if e := os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
	h := sha256.Sum256(data)
	return root, File{Path: "/native", Size: int64(len(data)), SHA256: hex.EncodeToString(h[:])}
}
func TestRequiredFiles(t *testing.T) {
	for _, kind := range []string{"intact", "corrupt", "truncated", "missing", "linked-file", "linked-parent", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			root, f := fixture(t)
			path := filepath.Join(root, "native")
			switch kind {
			case "corrupt":
				if e := os.WriteFile(path, []byte("a corrupted native fact"), 0600); e != nil {
					t.Fatal(e)
				}
			case "truncated":
				if e := os.Truncate(path, 3); e != nil {
					t.Fatal(e)
				}
			case "missing":
				if e := os.Remove(path); e != nil {
					t.Fatal(e)
				}
			case "linked-file":
				outside := filepath.Join(t.TempDir(), "source")
				data, e := os.ReadFile(path)
				if e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(outside, data, 0600); e != nil {
					t.Fatal(e)
				}
				if e = os.Remove(path); e != nil {
					t.Fatal(e)
				}
				if e = os.Symlink(outside, path); e != nil {
					t.Fatal(e)
				}
			case "linked-parent":
				if e := os.Symlink(root, filepath.Join(root, "link")); e != nil {
					t.Fatal(e)
				}
				f.Path = "/link/native"
			case "fifo":
				if e := os.Remove(path); e != nil {
					t.Fatal(e)
				}
				if e := syscall.Mkfifo(path, 0600); e != nil {
					t.Fatal(e)
				}
			}
			err := verifyFiles(root, []File{f})
			if (err == nil) != (kind == "intact") {
				t.Fatalf("%s: unexpected verification result %v", kind, err)
			}
		})
	}
}
func TestProbeConfiguration(t *testing.T) {
	_, f := fixture(t)
	base := Config{Nonce: strings.Repeat("a", 32), Files: []File{f}}
	if e := validateConfig(base); e != nil {
		t.Fatal(e)
	}
	for _, kind := range []string{"traversal", "relative", "root", "nul", "size", "hash", "duplicate", "count", "aggregate", "nonce"} {
		t.Run(kind, func(t *testing.T) {
			c := base
			c.Files = append([]File(nil), base.Files...)
			switch kind {
			case "traversal":
				c.Files[0].Path = "/dir/../native"
			case "relative":
				c.Files[0].Path = "native"
			case "root":
				c.Files[0].Path = "/"
			case "nul":
				c.Files[0].Path = "/native\x00"
			case "size":
				c.Files[0].Size = 64*1024*1024 + 1
			case "hash":
				c.Files[0].SHA256 = strings.Repeat("z", 64)
			case "duplicate":
				c.Files = append(c.Files, c.Files[0])
			case "count":
				c.Files = nil
			case "aggregate":
				c.Files = nil
				for i := 0; i < 5; i++ {
					entry := f
					entry.Path = "/" + string(rune('a'+i))
					entry.Size = 64 * 1024 * 1024
					c.Files = append(c.Files, entry)
				}
			case "nonce":
				c.Nonce = strings.Repeat("z", 32)
			}
			if validateConfig(c) == nil {
				t.Fatalf("invalid %s config was accepted", kind)
			}
		})
	}
}
func TestProbeRefusesOrdinaryProcess(t *testing.T) {
	if os.Getpid() == 1 {
		t.Skip("only run this test outside the guest init process")
	}
	r, e := run()
	if e == nil || r.Verified {
		t.Fatal("ordinary process must not produce a verified recovery receipt")
	}
}

func TestMountOnlyProbeRequiresExplicitMode(t *testing.T) {
	c := Config{Nonce: strings.Repeat("a", 32)}
	if validateConfig(c) == nil {
		t.Fatal("empty native catalog accepted without explicit mount-only mode")
	}
	c.MountOnly = true
	if err := validateConfig(c); err != nil {
		t.Fatal(err)
	}
}
