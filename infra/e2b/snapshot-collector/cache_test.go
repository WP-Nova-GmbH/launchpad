package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

const cacheBuildA = "11111111-1111-4111-8111-111111111111"
const cacheBuildB = "22222222-2222-4222-8222-222222222222"

func cacheFixture(t *testing.T) (string, string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cache, storage := filepath.Join(base, "cache"), filepath.Join(base, "templates")
	for _, path := range []string{cache, storage} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return cache, storage
}

func cacheFixtureFile(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}

func cacheFixtureIndex(t *testing.T, cache, scope, hash, id string) string {
	t.Helper()
	path := filepath.Join(cache, scope, "index", strings.Repeat(hash, 64))
	cacheFixtureFile(t, path, `{"template":{"build_id":"`+id+`"}}`)
	return path
}

func cacheFixtureMetadata(t *testing.T, storage, id string, mode bool) string {
	t.Helper()
	data := map[string]any{"version": 2, "template": map[string]string{"build_id": id}, "context": map[string]string{"user": "root"}}
	if mode {
		data["filesystem_only"] = true
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(storage, id, "metadata.json")
	cacheFixtureFile(t, path, string(encoded))
	return path
}

func TestBuildCacheRootsPreservesUnassignedIntermediateBuilds(t *testing.T) {
	cache, storage := cacheFixture(t)
	cacheFixtureIndex(t, cache, "team-scope", "a", cacheBuildB)
	cacheFixtureIndex(t, cache, "template-scope", "b", cacheBuildA)
	cacheFixtureIndex(t, cache, "template-scope", "c", cacheBuildB)
	cacheFixtureFile(t, filepath.Join(cache, "team-scope", "files", "blob.tar"), "blob contents are opaque")
	cacheFixtureMetadata(t, storage, cacheBuildA, false)
	cacheFixtureMetadata(t, storage, cacheBuildB, true)
	got, err := buildCacheRoots(cache, storage)
	if err != nil {
		t.Fatal(err)
	}
	want := []Root{{BuildID: cacheBuildA}, {BuildID: cacheBuildB, FilesystemOnly: true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestBuildCacheRootsRejectsDanglingOrInvalidIndexes(t *testing.T) {
	for name, payload := range map[string]string{
		"missing metadata": `{"template":{"build_id":"` + cacheBuildA + `"}}`,
		"invalid JSON":     `{`,
		"trailing JSON":    `{"template":{"build_id":"` + cacheBuildA + `"}} {}`,
		"unknown schema":   `{"template":{"build_id":"` + cacheBuildA + `"},"other":true}`,
		"missing template": `{}`,
		"null template":    `{"template":null}`,
		"invalid ID":       `{"template":{"build_id":"../../outside"}}`,
		"nil ID":           `{"template":{"build_id":"00000000-0000-0000-0000-000000000000"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			cache, storage := cacheFixture(t)
			cacheFixtureFile(t, filepath.Join(cache, "scope", "index", strings.Repeat("a", 64)), payload)
			got, err := buildCacheRoots(cache, storage)
			if err == nil || got != nil {
				t.Fatalf("expected no roots and error, got %#v %v", got, err)
			}
		})
	}
}

func TestBuildCacheRootsRejectsAmbiguousMetadata(t *testing.T) {
	for name, payload := range map[string]string{
		"invalid JSON":         `{`,
		"missing mode version": `{"template":{"build_id":"` + cacheBuildA + `"}}`,
		"deprecated version":   `{"version":1,"template":{"build_id":"` + cacheBuildA + `"},"filesystem_only":true}`,
		"unknown version":      `{"version":3,"template":{"build_id":"` + cacheBuildA + `"}}`,
		"wrong identity":       `{"version":2,"template":{"build_id":"` + cacheBuildB + `"}}`,
		"missing identity":     `{"version":2}`,
		"null mode":            `{"version":2,"template":{"build_id":"` + cacheBuildA + `"},"filesystem_only":null}`,
		"string mode":          `{"version":2,"template":{"build_id":"` + cacheBuildA + `"},"filesystem_only":"false"}`,
	} {
		t.Run(name, func(t *testing.T) {
			cache, storage := cacheFixture(t)
			cacheFixtureIndex(t, cache, "scope", "a", cacheBuildA)
			cacheFixtureFile(t, filepath.Join(storage, cacheBuildA, "metadata.json"), payload)
			got, err := buildCacheRoots(cache, storage)
			if err == nil || got != nil {
				t.Fatalf("expected no roots and error, got %#v %v", got, err)
			}
		})
	}
}

func TestBuildCacheRootsRejectsUnsafeFilesystemLayout(t *testing.T) {
	for _, name := range []string{"cache symlink", "storage symlink", "parent symlink", "relative", "noncanonical", "scope file", "scope symlink", "unknown scope entry", "index symlink", "index directory", "invalid hash", "index symlink file", "index fifo", "files symlink", "blob symlink", "blob fifo", "blob directory", "build symlink", "metadata symlink", "metadata fifo"} {
		t.Run(name, func(t *testing.T) {
			cache, storage := cacheFixture(t)
			index := cacheFixtureIndex(t, cache, "scope", "a", cacheBuildA)
			metadata := cacheFixtureMetadata(t, storage, cacheBuildA, false)
			link := func(target, path string) {
				t.Helper()
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			}
			remove := func(path string) {
				t.Helper()
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			fifo := func(path string) {
				t.Helper()
				if err := syscall.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			}
			switch name {
			case "cache symlink":
				path := cache + "-link"
				link(cache, path)
				cache = path
			case "storage symlink":
				path := storage + "-link"
				link(storage, path)
				storage = path
			case "parent symlink":
				path := filepath.Dir(cache) + "-link"
				link(filepath.Dir(cache), path)
				cache = filepath.Join(path, "cache")
			case "relative":
				cache = "relative"
			case "noncanonical":
				cache += string(filepath.Separator) + "."
			case "scope file":
				cacheFixtureFile(t, filepath.Join(cache, "scope-file"), "not a scope")
			case "scope symlink":
				link(filepath.Join(cache, "scope"), filepath.Join(cache, "scope-link"))
			case "unknown scope entry":
				if err := os.Mkdir(filepath.Join(cache, "scope", "other"), 0700); err != nil {
					t.Fatal(err)
				}
			case "index symlink":
				if err := os.Rename(filepath.Dir(index), filepath.Join(filepath.Dir(cache), "real-index")); err != nil {
					t.Fatal(err)
				}
				link(filepath.Join(filepath.Dir(cache), "real-index"), filepath.Dir(index))
			case "index directory":
				remove(index)
				if err := os.Mkdir(index, 0700); err != nil {
					t.Fatal(err)
				}
			case "invalid hash":
				if err := os.Rename(index, index+"x"); err != nil {
					t.Fatal(err)
				}
			case "index symlink file":
				remove(index)
				link(metadata, index)
			case "index fifo":
				remove(index)
				fifo(index)
			case "files symlink":
				link(storage, filepath.Join(cache, "scope", "files"))
			case "blob symlink":
				path := filepath.Join(cache, "scope", "files", "blob.tar")
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				link(metadata, path)
			case "blob fifo":
				path := filepath.Join(cache, "scope", "files", "blob.tar")
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				fifo(path)
			case "blob directory":
				if err := os.MkdirAll(filepath.Join(cache, "scope", "files", "blob.tar"), 0700); err != nil {
					t.Fatal(err)
				}
			case "build symlink":
				path := filepath.Join(storage, cacheBuildA)
				if err := os.Rename(path, path+"-real"); err != nil {
					t.Fatal(err)
				}
				link(path+"-real", path)
			case "metadata symlink":
				remove(metadata)
				link(index, metadata)
			case "metadata fifo":
				remove(metadata)
				fifo(metadata)
			}
			got, err := buildCacheRoots(cache, storage)
			if err == nil || got != nil {
				t.Fatalf("expected no roots and error, got %#v %v", got, err)
			}
		})
	}
}

func TestBuildCacheRootsAllowsEmptyCache(t *testing.T) {
	cache, storage := cacheFixture(t)
	got, err := buildCacheRoots(cache, storage)
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("got %#v %v", got, err)
	}
}

func TestReadMetadataRootValidatesIdentityWithoutCreatingDirectories(t *testing.T) {
	_, storage := cacheFixture(t)
	for _, id := range []string{"../outside", "00000000-0000-0000-0000-000000000000", cacheBuildA} {
		got, err := readMetadataRoot(storage, id)
		if err == nil || got != (Root{}) {
			t.Fatalf("expected empty root and error for %q: %#v %v", id, got, err)
		}
	}
	entries, err := os.ReadDir(storage)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("metadata read created directories: %#v", entries)
	}
	cacheFixtureMetadata(t, storage, cacheBuildA, true)
	got, err := readMetadataRoot(storage, cacheBuildA)
	if err != nil || got != (Root{BuildID: cacheBuildA, FilesystemOnly: true}) {
		t.Fatalf("unexpected metadata root: %#v %v", got, err)
	}
}
