package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"
)

type storedLayer struct {
	BuildID        string
	AllocatedBytes int64
	LogicalBytes   int64
	LatestWrite    time.Time
	fingerprint    string
}

type storageInventory struct {
	Layers  []storedLayer
	Unknown []string
}

func openStorage(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("storage root must be a canonical absolute directory")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if resolved != path {
		return nil, errors.New("storage root must not traverse symlinks")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("storage root must be a directory")
	}
	return os.OpenRoot(path)
}

func nativeLayerFile(name string) bool {
	if name == "metadata.json" || name == "snapfile" {
		return true
	}
	for _, base := range []string{"rootfs.ext4", "memfile"} {
		if name == base || name == base+".header" {
			return true
		}
		for _, suffix := range []string{".lz4", ".zstd"} {
			if name == base+suffix || name == base+suffix+".uncompressed-size" {
				return true
			}
		}
		if name == base+".uncompressed-size" {
			return true
		}
	}
	return false
}

func entries(root *os.Root, name string) ([]os.DirEntry, error) {
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	items, readErr := file.ReadDir(-1)
	err = errors.Join(readErr, file.Close())
	sort.Slice(items, func(i, j int) bool { return items[i].Name() < items[j].Name() })
	return items, err
}

func systemStat(info os.FileInfo) reflect.Value {
	value := reflect.ValueOf(info.Sys())
	if value.IsValid() && value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value.IsValid() && value.Kind() == reflect.Struct {
		return value
	}
	return reflect.Value{}
}

// Blocks is present in Linux and macOS stat data. Other platforms report zero
// rather than claiming logical sparse-file bytes can actually be reclaimed.
func allocatedBytes(info os.FileInfo) int64 {
	value := systemStat(info)
	if value.IsValid() {
		blocks := value.FieldByName("Blocks")
		if blocks.IsValid() && blocks.CanInt() && blocks.Int() >= 0 && blocks.Int() <= math.MaxInt64/512 {
			return blocks.Int() * 512
		}
	}
	return 0
}

func stamp(writer io.Writer, name string, info os.FileInfo) {
	fmt.Fprintf(writer, "%q mode=%d size=%d mtime=%d", name, info.Mode(), info.Size(), info.ModTime().UnixNano())
	value := systemStat(info)
	if value.IsValid() {
		// Omit atime: scanning directories itself may change it. Identity,
		// ownership and ctime catch replacement or writes with restored mtime.
		for _, field := range []string{"Dev", "Ino", "Nlink", "Uid", "Gid", "Blocks", "Ctim", "Ctimespec"} {
			member := value.FieldByName(field)
			if member.IsValid() && member.CanInterface() {
				fmt.Fprintf(writer, " %s=%v", field, member.Interface())
			}
		}
	}
	fmt.Fprintln(writer)
}

func readStoredLayer(root *os.Root, id string) (storedLayer, []string, error) {
	info, err := root.Lstat(id)
	if err != nil {
		return storedLayer{}, nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return storedLayer{}, []string{id}, nil
	}
	items, err := entries(root, id)
	if err != nil {
		return storedLayer{}, nil, err
	}
	layer := storedLayer{BuildID: id, LatestWrite: info.ModTime()}
	digest := sha256.New()
	var initialDirectory strings.Builder
	stamp(&initialDirectory, id, info)
	add := func(name string, entry os.FileInfo) error {
		allocated := allocatedBytes(entry)
		if entry.Size() < 0 || layer.LogicalBytes > math.MaxInt64-entry.Size() || layer.AllocatedBytes > math.MaxInt64-allocated {
			return errors.New("storage size overflow")
		}
		layer.LogicalBytes += entry.Size()
		layer.AllocatedBytes += allocated
		if entry.ModTime().After(layer.LatestWrite) {
			layer.LatestWrite = entry.ModTime()
		}
		stamp(digest, name, entry)
		return nil
	}
	if err := add(id, info); err != nil {
		return storedLayer{}, nil, err
	}
	unknown := []string{}
	for _, item := range items {
		name := filepath.Join(id, item.Name())
		entry, err := root.Lstat(name)
		if err != nil {
			return storedLayer{}, nil, err
		}
		if !entry.Mode().IsRegular() || !nativeLayerFile(item.Name()) {
			unknown = append(unknown, name)
			continue
		}
		if err := add(name, entry); err != nil {
			return storedLayer{}, nil, err
		}
	}
	current, err := root.Lstat(id)
	if err != nil {
		return storedLayer{}, nil, err
	}
	var finalDirectory strings.Builder
	stamp(&finalDirectory, id, current)
	if initialDirectory.String() != finalDirectory.String() {
		return storedLayer{}, nil, fmt.Errorf("build directory changed during scan: %s", id)
	}
	layer.fingerprint = hex.EncodeToString(digest.Sum(nil))
	return layer, unknown, nil
}

func scanStorage(path string) (storageInventory, error) {
	root, err := openStorage(path)
	if err != nil {
		return storageInventory{}, err
	}
	defer root.Close()
	items, err := entries(root, ".")
	if err != nil {
		return storageInventory{}, err
	}
	inventory := storageInventory{Layers: []storedLayer{}, Unknown: []string{}}
	for _, item := range items {
		if !validBuildID(item.Name()) {
			inventory.Unknown = append(inventory.Unknown, item.Name())
			continue
		}
		layer, unknown, err := readStoredLayer(root, item.Name())
		if err != nil {
			return storageInventory{}, fmt.Errorf("scan build %s: %w", item.Name(), err)
		}
		if len(unknown) != 0 {
			inventory.Unknown = append(inventory.Unknown, unknown...)
			continue
		}
		inventory.Layers = append(inventory.Layers, layer)
	}
	sort.Strings(inventory.Unknown)
	return inventory, nil
}

func validateCandidate(root *os.Root, candidate storedLayer, retained map[string]struct{}) error {
	if !validBuildID(candidate.BuildID) || candidate.fingerprint == "" {
		return errors.New("candidate requires a scanned canonical build ID and fingerprint")
	}
	if _, keep := retained[candidate.BuildID]; keep {
		return fmt.Errorf("candidate is retained: %s", candidate.BuildID)
	}
	current, unknown, err := readStoredLayer(root, candidate.BuildID)
	if err != nil {
		return err
	}
	if len(unknown) != 0 || current.fingerprint != candidate.fingerprint || current.AllocatedBytes != candidate.AllocatedBytes ||
		current.LogicalBytes != candidate.LogicalBytes || !current.LatestWrite.Equal(candidate.LatestWrite) {
		return fmt.Errorf("candidate changed since scan: %s", candidate.BuildID)
	}
	return nil
}

func journalDeletion(writer io.Writer, event string, layer storedLayer) error {
	data, err := json.Marshal(struct {
		Event          string `json:"event"`
		BuildID        string `json:"buildId"`
		Fingerprint    string `json:"fingerprint"`
		AllocatedBytes int64  `json:"allocatedBytes"`
		LogicalBytes   int64  `json:"logicalBytes"`
	}{event, layer.BuildID, layer.fingerprint, layer.AllocatedBytes, layer.LogicalBytes})
	if err != nil {
		return err
	}
	data = append(data, '\n')
	n, err := writer.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	if flusher, ok := writer.(interface{ Flush() error }); ok {
		if err := flusher.Flush(); err != nil {
			return err
		}
	}
	if syncer, ok := writer.(interface{ Sync() error }); ok {
		return syncer.Sync()
	}
	return nil
}

// sweepStorage requires an externally stopped and admission-frozen host. The
// fingerprint checks detect stale plans; they do not replace that writer fence.
func sweepStorage(ctx context.Context, path string, candidates []storedLayer, retained map[string]struct{}, journal io.Writer, checkLocked func(context.Context) error) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if journal == nil {
		return nil, errors.New("deletion journal is required")
	}
	if checkLocked == nil {
		return nil, errors.New("live catalogue lock check is required")
	}
	root, err := openStorage(path)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if _, duplicate := seen[candidate.BuildID]; duplicate {
			return nil, fmt.Errorf("duplicate candidate: %s", candidate.BuildID)
		}
		seen[candidate.BuildID] = struct{}{}
		if err := validateCandidate(root, candidate, retained); err != nil {
			return nil, err
		}
	}
	deleted := []string{}
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return deleted, err
		}
		if err := validateCandidate(root, candidate, retained); err != nil {
			return deleted, err
		}
		if err := journalDeletion(journal, "intent", candidate); err != nil {
			return deleted, err
		}
		if err := ctx.Err(); err != nil {
			return deleted, err
		}
		if err := validateCandidate(root, candidate, retained); err != nil {
			return deleted, err
		}
		if err := checkLocked(ctx); err != nil {
			return deleted, err
		}
		if err := ctx.Err(); err != nil {
			return deleted, err
		}
		if err := root.RemoveAll(candidate.BuildID); err != nil {
			return deleted, err
		}
		if _, err := root.Lstat(candidate.BuildID); !errors.Is(err, fs.ErrNotExist) {
			return deleted, fmt.Errorf("build removal is unconfirmed: %s", candidate.BuildID)
		}
		deleted = append(deleted, candidate.BuildID)
		directory, err := root.Open(".")
		if err != nil {
			return deleted, err
		}
		if err := errors.Join(directory.Sync(), directory.Close()); err != nil {
			return deleted, err
		}
		if err := journalDeletion(journal, "deleted", candidate); err != nil {
			return deleted, err
		}
	}
	return deleted, ctx.Err()
}
