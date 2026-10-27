//go:build linux

// The probe is an initrd PID 1. It never executes code from the recovered disk.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type Config struct {
	Nonce     string `json:"nonce"`
	MountOnly bool   `json:"mountOnly"`
	Files     []File `json:"files"`
}
type Receipt struct {
	Format        string `json:"format"`
	Phase         string `json:"phase"`
	Nonce         string `json:"nonce"`
	Verified      bool   `json:"verified"`
	Files         int    `json:"files"`
	MountOnly     bool   `json:"mountOnly"`
	UserProcesses []int  `json:"userProcesses"`
	Error         string `json:"error,omitempty"`
}

// Required files come from the verified recovery catalog, not from saved guest code.
func validateConfig(c Config) error {
	if len(c.Nonce) != 32 {
		return fmt.Errorf("invalid trusted probe nonce")
	}
	if _, e := hex.DecodeString(c.Nonce); e != nil {
		return e
	}
	if (!c.MountOnly && len(c.Files) < 1) || len(c.Files) > 256 {
		return fmt.Errorf("invalid trusted probe file count")
	}
	seen := map[string]bool{}
	var total int64
	for _, f := range c.Files {
		if !strings.HasPrefix(f.Path, "/") || f.Path == "/" || filepath.Clean(f.Path) != f.Path || strings.ContainsRune(f.Path, 0) || f.Size < 0 || f.Size > 64*1024*1024 || len(f.SHA256) != 64 || seen[f.Path] {
			return fmt.Errorf("invalid required file")
		}
		if _, e := hex.DecodeString(f.SHA256); e != nil {
			return e
		}
		seen[f.Path] = true
		total += f.Size
	}
	if total > 256*1024*1024 {
		return fmt.Errorf("required native files exceed probe limit")
	}
	return nil
}
func verifyFiles(root string, files []File) error {
	for _, f := range files {
		current := root
		for _, part := range strings.Split(strings.TrimPrefix(f.Path, "/"), "/") {
			current = filepath.Join(current, part)
			info, e := os.Lstat(current)
			if e != nil {
				return e
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("linked recovered file")
			}
		}
		info, e := os.Lstat(current)
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("required file is not regular")
		}
		file, e := os.Open(current)
		if e != nil {
			return e
		}
		info, e = file.Stat()
		if e != nil {
			file.Close()
			return e
		}
		if !info.Mode().IsRegular() || info.Size() != f.Size {
			file.Close()
			return fmt.Errorf("required file size mismatch")
		}
		hash := sha256.New()
		n, e := io.Copy(hash, io.LimitReader(file, f.Size+1))
		closeErr := file.Close()
		if e != nil {
			return e
		}
		if closeErr != nil {
			return closeErr
		}
		if n != f.Size || hex.EncodeToString(hash.Sum(nil)) != f.SHA256 {
			return fmt.Errorf("required file checksum mismatch")
		}
	}
	return nil
}
func run() (Receipt, error) {
	r := Receipt{Format: "launchpad-disk-probe-v1", Phase: "quarantine", UserProcesses: []int{}}
	if os.Getpid() != 1 {
		return r, fmt.Errorf("the trusted probe must be PID 1")
	}
	for _, m := range []struct{ src, target, kind string }{{"proc", "/proc", "proc"}, {"sysfs", "/sys", "sysfs"}, {"devtmpfs", "/dev", "devtmpfs"}} {
		if e := os.MkdirAll(m.target, 0700); e != nil {
			return r, e
		}
		if e := syscall.Mount(m.src, m.target, m.kind, syscall.MS_NOSUID|syscall.MS_NOEXEC, ""); e != nil {
			return r, e
		}
	}
	b, e := os.ReadFile("/proof.json")
	if e != nil {
		return r, e
	}
	var c Config
	if e = json.Unmarshal(b, &c); e != nil {
		return r, e
	}
	r.Nonce = c.Nonce
	r.MountOnly = c.MountOnly
	if e = validateConfig(c); e != nil {
		return r, e
	}
	if e = os.MkdirAll("/recovered", 0700); e != nil {
		return r, e
	}
	flags := uintptr(syscall.MS_RDONLY | syscall.MS_NOEXEC | syscall.MS_NOSUID | syscall.MS_NODEV)
	if e = syscall.Mount("/dev/vda", "/recovered", "ext4", flags, "noload"); e != nil {
		return r, e
	}
	var st syscall.Statfs_t
	if e = syscall.Statfs("/recovered", &st); e != nil {
		return r, e
	}
	if uint64(st.Flags)&uint64(flags) != uint64(flags) {
		return r, fmt.Errorf("recovered disk mount lacks quarantine flags")
	}
	if e = verifyFiles("/recovered", c.Files); e != nil {
		return r, e
	}
	r.Files = len(c.Files)
	entries, e := os.ReadDir("/proc")
	if e != nil {
		return r, e
	}
	for _, p := range entries {
		pid, e := strconv.Atoi(p.Name())
		if e != nil {
			continue
		}
		cmd, e := os.ReadFile(filepath.Join("/proc", p.Name(), "cmdline"))
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return r, e
		}
		if len(cmd) > 0 {
			r.UserProcesses = append(r.UserProcesses, pid)
		}
	}
	if len(r.UserProcesses) != 1 || r.UserProcesses[0] != 1 {
		return r, fmt.Errorf("unexpected userspace process in quarantine")
	}
	// A write must fail even for the privileged probe. No startup service is loaded.
	if file, e := os.OpenFile("/recovered/launchpad-quarantine-write-canary", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600); e == nil {
		file.Close()
		return r, fmt.Errorf("recovered disk is writable")
	} else if !errors.Is(e, syscall.EROFS) {
		return r, e
	}
	r.Verified = true
	return r, nil
}
func main() {
	r, e := run()
	if e != nil {
		r.Error = e.Error()
	}
	b, _ := json.Marshal(r)
	fmt.Println("[launchpad-disk-probe-v1]" + string(b))
	syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	select {}
}
