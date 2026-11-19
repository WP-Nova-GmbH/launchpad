package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// buildCacheRoots preserves intermediate templates that have no catalog
// assignment but remain start targets through E2B's native layer cache. Both
// paths name existing directories: storagePath is the templates directory.
func buildCacheRoots(cachePath, storagePath string) ([]Root, error) {
	cache, err := openCacheDirectory(cachePath)
	if err != nil {
		return nil, fmt.Errorf("open build cache: %w", err)
	}
	defer cache.Close()
	storage, err := openCacheDirectory(storagePath)
	if err != nil {
		return nil, fmt.Errorf("open template storage: %w", err)
	}
	if err := storage.Close(); err != nil {
		return nil, err
	}
	scopes, err := fs.ReadDir(cache.FS(), ".")
	if err != nil {
		return nil, fmt.Errorf("list build-cache scopes: %w", err)
	}
	ids := map[string]struct{}{}
	for _, scope := range scopes {
		entries, err := cacheScopeBuilds(cache, scope.Name())
		if err != nil {
			return nil, fmt.Errorf("read cache scope %q: %w", scope.Name(), err)
		}
		for _, id := range entries {
			ids[id] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	roots := make([]Root, 0, len(ordered))
	for _, id := range ordered {
		root, err := readMetadataRoot(storagePath, id)
		if err != nil {
			return nil, fmt.Errorf("read cached build %s metadata: %w", id, err)
		}
		roots = append(roots, root)
	}
	return roots, nil
}

func openCacheDirectory(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("path must be canonical and absolute")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if resolved != path {
		return nil, errors.New("path must not contain symlinks")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("path must be a directory")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		root.Close()
		return nil, fmt.Errorf("directory %q changed while opening", path)
	}
	return root, nil
}

func cacheChildDirectory(parent *os.Root, name string) (*os.Root, error) {
	info, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%q must be a real directory", name)
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		root.Close()
		return nil, fmt.Errorf("directory %q changed while opening", name)
	}
	return root, nil
}

func cacheScopeBuilds(cache *os.Root, name string) ([]string, error) {
	scope, err := cacheChildDirectory(cache, name)
	if err != nil {
		return nil, err
	}
	defer scope.Close()
	entries, err := fs.ReadDir(scope.FS(), ".")
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, entry := range entries {
		dir, err := cacheChildDirectory(scope, entry.Name())
		if err != nil {
			return nil, err
		}
		var found []string
		switch entry.Name() {
		case "index":
			found, err = cacheIndexBuilds(dir)
		case "files":
			err = cacheCheckBlobs(dir)
		default:
			err = fmt.Errorf("unknown build-cache scope entry %q", entry.Name())
		}
		closeErr := dir.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		ids = append(ids, found...)
	}
	return ids, nil
}

// Native files/ objects are uploaded tar blobs, not reference indexes. Inspect
// their file types without opening blob contents or following any symlink.
func cacheCheckBlobs(dir *os.Root) error {
	entries, err := fs.ReadDir(dir.FS(), ".")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		info, err := dir.Lstat(entry.Name())
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("build-cache blob %q must be a regular file", entry.Name())
		}
	}
	return nil
}

func cacheIndexBuilds(index *os.Root) ([]string, error) {
	entries, err := fs.ReadDir(index.FS(), ".")
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if len(name) != 64 {
			return nil, fmt.Errorf("invalid build-cache hash %q", name)
		}
		for _, char := range name {
			if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
				return nil, fmt.Errorf("invalid build-cache hash %q", name)
			}
		}
		data, err := cacheReadRegular(index, name, 64<<10)
		if err != nil {
			return nil, err
		}
		var layer struct {
			Template *struct {
				BuildID string `json:"build_id"`
			} `json:"template"`
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&layer); err != nil {
			return nil, fmt.Errorf("decode cache index %s: %w", name, err)
		}
		if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("cache index %s must contain one JSON object", name)
		}
		if layer.Template == nil || !validBuildID(layer.Template.BuildID) {
			return nil, fmt.Errorf("cache index %s requires a canonical non-nil build UUID", name)
		}
		ids = append(ids, layer.Template.BuildID)
	}
	return ids, nil
}

func cacheReadRegular(dir *os.Root, name string, limit int64) ([]byte, error) {
	before, err := dir.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, fmt.Errorf("%q must be a regular file of at most %d bytes", name, limit)
	}
	file, err := dir.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(before, opened) || !opened.Mode().IsRegular() {
		return nil, fmt.Errorf("%q changed while opening", name)
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return nil, fmt.Errorf("%q changed while reading or exceeded its size limit", name)
	}
	return data, nil
}

// readMetadataRoot reads stock metadata without creating a directory. The
// caller may use it for either native runtime roots or layer-cache roots.
func readMetadataRoot(storagePath, buildID string) (Root, error) {
	if !validBuildID(buildID) {
		return Root{}, errors.New("metadata root requires a canonical non-nil build UUID")
	}
	storage, err := openCacheDirectory(storagePath)
	if err != nil {
		return Root{}, err
	}
	defer storage.Close()
	filesystemOnly, err := cacheBuildMode(storage, buildID)
	if err != nil {
		return Root{}, err
	}
	return Root{BuildID: buildID, FilesystemOnly: filesystemOnly}, nil
}

func cacheBuildMode(storage *os.Root, id string) (bool, error) {
	build, err := cacheChildDirectory(storage, id)
	if err != nil {
		return false, err
	}
	defer build.Close()
	data, err := cacheReadRegular(build, "metadata.json", 64<<20)
	if err != nil {
		return false, err
	}
	// metadata.Template contains many unrelated fields. Read only identity and
	// mode; unlike the small index record, the metadata isn't a closed schema.
	var metadata struct {
		Version  *uint64 `json:"version"`
		Template *struct {
			BuildID string `json:"build_id"`
		} `json:"template"`
		FilesystemOnly json.RawMessage `json:"filesystem_only"`
	}
	if err := json.Unmarshal(data, &metadata); err != nil {
		return false, err
	}
	if metadata.Version == nil || *metadata.Version != 2 || metadata.Template == nil || metadata.Template.BuildID != id {
		return false, errors.New("cached metadata requires version 2 and its own matching template.build_id")
	}
	// Stock E2B omits false: absent filesystem_only means full memory. Null is
	// not an emitted boolean and is rejected instead of guessing a mode.
	filesystemOnly := false
	if len(metadata.FilesystemOnly) != 0 {
		if bytes.Equal(bytes.TrimSpace(metadata.FilesystemOnly), []byte("null")) {
			return false, errors.New("cached metadata filesystem_only must be a boolean")
		}
		if err := json.Unmarshal(metadata.FilesystemOnly, &filesystemOnly); err != nil {
			return false, err
		}
	}
	return filesystemOnly, nil
}
