package main

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/e2b-dev/infra/packages/shared/pkg/storage"
	"github.com/e2b-dev/infra/packages/shared/pkg/storage/header"
	"github.com/google/uuid"
)

const (
	storedRootID           = "11111111-1111-4111-8111-111111111111"
	storedParentID         = "22222222-2222-4222-8222-222222222222"
	storedUnusedAncestorID = "33333333-3333-4333-8333-333333333333"
)

type storedFixture struct {
	t    *testing.T
	path string
	root *header.Header
}

func newStoredFixture(t *testing.T, version uint64, codec storage.CompressionType) *storedFixture {
	t.Helper()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	id, parent := uuid.MustParse(storedRootID), uuid.MustParse(storedParentID)
	meta := header.NewTemplateMetadata(id, header.PageSize, 3*header.PageSize)
	meta.Version = version
	h, err := header.NewHeader(meta, []header.BuildMap{
		{Offset: 0, Length: header.PageSize, BuildId: id},
		{Offset: header.PageSize, Length: header.PageSize, BuildId: parent},
		{Offset: 2 * header.PageSize, Length: header.PageSize, BuildId: uuid.Nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	if version >= header.MetadataVersionV4 {
		h.SetBuild(id, header.BuildData{})
		bd := header.BuildData{}
		if codec != storage.CompressionNone {
			bd.FrameData = storage.NewFullFrameTable(codec, []storage.FrameSize{{U: header.PageSize, C: 1}}).Table()
		}
		h.SetBuild(parent, bd)
	}
	f := &storedFixture{t: t, path: path, root: h}
	f.writeHeader(storage.RootfsName, h)
	f.write(storedRootID, storage.RootfsName, []byte{1})
	f.write(storedParentID, storage.RootfsName+codec.Suffix(), []byte{2})
	mem, err := header.NewHeader(header.NewTemplateMetadata(id, 2<<20, header.PageSize), nil)
	if err != nil {
		t.Fatal(err)
	}
	mem.Metadata.Version = version
	if version >= header.MetadataVersionV4 {
		mem.SetBuild(id, header.BuildData{})
	}
	f.writeHeader(storage.MemfileName, mem)
	f.write(storedRootID, storage.MemfileName, []byte{3})
	return f
}

func (f *storedFixture) write(id, name string, data []byte) {
	f.t.Helper()
	dir := filepath.Join(f.path, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *storedFixture) writeHeader(name string, h *header.Header) {
	f.t.Helper()
	f.writeBuildHeader(storedRootID, name, h)
}

func (f *storedFixture) writeBuildHeader(id, name string, h *header.Header) {
	f.t.Helper()
	data, err := header.SerializeHeader(h)
	if err != nil {
		f.t.Fatal(err)
	}
	f.write(id, name+storage.HeaderSuffix, data)
}

func (f *storedFixture) writeAncestorHeader(name string, version uint64, codec storage.CompressionType) *header.Header {
	f.t.Helper()
	id := uuid.MustParse(storedParentID)
	meta := header.NewTemplateMetadata(id, header.PageSize, 2*header.PageSize)
	meta.Version = version
	h, err := header.NewHeader(meta, []header.BuildMap{
		{Length: header.PageSize, BuildId: id},
		{Offset: header.PageSize, Length: header.PageSize, BuildId: uuid.MustParse(storedUnusedAncestorID)},
	})
	mustStored(f.t, err)
	if version >= header.MetadataVersionV4 {
		bd := header.BuildData{}
		if codec != storage.CompressionNone {
			bd.FrameData = storage.NewFullFrameTable(codec, []storage.FrameSize{{U: header.PageSize, C: 1}}).Table()
		}
		h.SetBuild(id, bd)
	}
	f.writeBuildHeader(storedParentID, name, h)
	return h
}

func (f *storedFixture) rootfsHeader() string {
	return filepath.Join(f.path, storedRootID, storage.RootfsName+storage.HeaderSuffix)
}

func TestStoredReferencesNativeFormats(t *testing.T) {
	for _, version := range []uint64{1, 2, 3, 4, 5} {
		t.Run(string(rune('0'+version)), func(t *testing.T) {
			f := newStoredFixture(t, version, storage.CompressionNone)
			got, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID})
			if err != nil {
				t.Fatal(err)
			}
			want := []LayerRef{{storedRootID, "rootfs"}, {storedParentID, "rootfs"}, {storedRootID, "memory"}}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("references = %#v, want %#v", got, want)
			}
			// Only root headers exist: native maps already contain the ancestor
			// references, so reading an ancestor header would fail this test.
			if _, err := os.Stat(filepath.Join(f.path, storedParentID, storage.RootfsName+storage.HeaderSuffix)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("ancestor header unexpectedly exists: %v", err)
			}
		})
	}
}

func TestStoredReferencesCompressedObjects(t *testing.T) {
	for _, version := range []uint64{4, 5} {
		for _, codec := range []storage.CompressionType{storage.CompressionZstd, storage.CompressionLZ4} {
			t.Run(string(rune('0'+version))+codec.Suffix(), func(t *testing.T) {
				f := newStoredFixture(t, version, codec)
				if _, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID}); err != nil {
					t.Fatal(err)
				}
				compressed := filepath.Join(f.path, storedParentID, storage.RootfsName+codec.Suffix())
				if err := os.Rename(compressed, strings.TrimSuffix(compressed, codec.Suffix())); err != nil {
					t.Fatal(err)
				}
				if refs, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID}); err == nil || refs != nil {
					t.Fatalf("missing compressed object accepted: %#v, %v", refs, err)
				}
			})
		}
	}
}

func TestStoredReferencesAncestorCodecFallback(t *testing.T) {
	for _, rootVersion := range []uint64{4, 5} {
		for _, ancestor := range []struct {
			name        string
			version     uint64
			codec       storage.CompressionType
			missingSelf bool
		}{
			{name: "v3-uncompressed", version: 3},
			{name: "v4-uncompressed", version: 4},
			{name: "v5-uncompressed", version: 5},
			{name: "v5-legacy-self", version: 5, missingSelf: true},
			{name: "v4-zstd", version: 4, codec: storage.CompressionZstd},
			{name: "v5-lz4", version: 5, codec: storage.CompressionLZ4},
		} {
			t.Run(string(rune('0'+rootVersion))+"/"+ancestor.name, func(t *testing.T) {
				f := newStoredFixture(t, rootVersion, ancestor.codec)
				delete(f.root.Builds, uuid.MustParse(storedParentID))
				f.writeHeader(storage.RootfsName, f.root)
				h := f.writeAncestorHeader(storage.RootfsName, ancestor.version, ancestor.codec)
				if ancestor.missingSelf {
					delete(h.Builds, uuid.MustParse(storedParentID))
					f.writeBuildHeader(storedParentID, storage.RootfsName, h)
				}
				got, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID})
				mustStored(t, err)
				want := []LayerRef{{storedRootID, "rootfs"}, {storedParentID, "rootfs"}, {storedRootID, "memory"}}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("fallback references = %#v, want %#v", got, want)
				}
				// The ancestor's own ancestor has no stored directory. Its mapping
				// validates the codec source, but is not part of this root's graph.
				if _, err := os.Stat(filepath.Join(f.path, storedUnusedAncestorID)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("codec fallback created an unrelated ancestor: %v", err)
				}
			})
		}
	}
}

func TestStoredReferencesMemoryAncestorCodecFallback(t *testing.T) {
	f := newStoredFixture(t, 5, storage.CompressionNone)
	id, parent := uuid.MustParse(storedRootID), uuid.MustParse(storedParentID)
	h, err := header.NewHeader(header.NewTemplateMetadata(id, 2<<20, 2*header.PageSize), []header.BuildMap{
		{Length: header.PageSize, BuildId: id},
		{Offset: header.PageSize, Length: header.PageSize, BuildId: parent},
	})
	mustStored(t, err)
	h.Metadata.Version = 5
	h.SetBuild(id, header.BuildData{})
	f.writeHeader(storage.MemfileName, h)
	f.writeAncestorHeader(storage.MemfileName, 4, storage.CompressionLZ4)
	f.write(storedParentID, storage.MemfileName+storage.CompressionLZ4.Suffix(), []byte{4})
	// A known rootfs codec must not read this irrelevant malformed header;
	// the memory fallback must read the ancestor's memory header instead.
	f.write(storedParentID, storage.RootfsName+storage.HeaderSuffix, []byte{1})
	got, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID})
	mustStored(t, err)
	want := []LayerRef{{storedRootID, "rootfs"}, {storedParentID, "rootfs"}, {storedRootID, "memory"}, {storedParentID, "memory"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("memory fallback references = %#v, want %#v", got, want)
	}
}

func TestStoredReferencesLegacyZeroAncestorCodecFallback(t *testing.T) {
	for _, rootVersion := range []uint64{4, 5} {
		for _, codec := range []storage.CompressionType{storage.CompressionZstd, storage.CompressionLZ4} {
			t.Run(string(rune('0'+rootVersion))+codec.Suffix(), func(t *testing.T) {
				f := newStoredFixture(t, rootVersion, codec)
				f.root.SetBuild(uuid.MustParse(storedParentID), header.BuildData{})
				f.writeHeader(storage.RootfsName, f.root)
				f.writeAncestorHeader(storage.RootfsName, 5, codec)
				got, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID})
				mustStored(t, err)
				want := []LayerRef{{storedRootID, "rootfs"}, {storedParentID, "rootfs"}, {storedRootID, "memory"}}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("legacy zero fallback references = %#v, want %#v", got, want)
				}
			})
		}
	}
}

func TestStoredReferencesKnownAncestorCodecDoesNotFallBack(t *testing.T) {
	for _, codec := range []storage.CompressionType{storage.CompressionNone, storage.CompressionZstd} {
		t.Run(codec.String(), func(t *testing.T) {
			f := newStoredFixture(t, 5, storage.CompressionLZ4)
			bd := header.BuildData{Size: int64(header.PageSize)}
			if codec != storage.CompressionNone {
				bd.FrameData = storage.NewFullFrameTable(codec, []storage.FrameSize{{U: header.PageSize, C: 1}}).Table()
			}
			f.root.SetBuild(uuid.MustParse(storedParentID), bd)
			f.writeHeader(storage.RootfsName, f.root)
			f.writeAncestorHeader(storage.RootfsName, 5, storage.CompressionLZ4)
			if refs, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID}); err == nil || refs != nil {
				t.Fatalf("known codec was silently replaced: %#v, %v", refs, err)
			}
		})
	}
}

func TestStoredReferencesRejectInvalidAncestorCodecFallback(t *testing.T) {
	for name, mutate := range map[string]func(*storedFixture, *header.Header){
		"missing header": func(f *storedFixture, _ *header.Header) {
			mustStored(f.t, os.Remove(filepath.Join(f.path, storedParentID, storage.RootfsName+storage.HeaderSuffix)))
		},
		"wrong artifact": func(f *storedFixture, h *header.Header) {
			f.writeBuildHeader(storedParentID, storage.MemfileName, h)
			mustStored(f.t, os.Remove(filepath.Join(f.path, storedParentID, storage.RootfsName+storage.HeaderSuffix)))
		},
		"truncated header": func(f *storedFixture, _ *header.Header) {
			f.write(storedParentID, storage.RootfsName+storage.HeaderSuffix, []byte{1})
		},
		"metadata only": func(f *storedFixture, _ *header.Header) {
			data, err := os.ReadFile(filepath.Join(f.path, storedParentID, storage.RootfsName+storage.HeaderSuffix))
			mustStored(f.t, err)
			f.write(storedParentID, storage.RootfsName+storage.HeaderSuffix, data[:binary.Size(header.Metadata{})])
		},
		"wrong self ID": func(f *storedFixture, h *header.Header) {
			h.Metadata.BuildId = uuid.MustParse(storedRootID)
			f.writeBuildHeader(storedParentID, storage.RootfsName, h)
		},
		"unknown version": func(f *storedFixture, _ *header.Header) {
			data, err := os.ReadFile(filepath.Join(f.path, storedParentID, storage.RootfsName+storage.HeaderSuffix))
			mustStored(f.t, err)
			binary.LittleEndian.PutUint64(data, 99)
			f.write(storedParentID, storage.RootfsName+storage.HeaderSuffix, data)
		},
		"incomplete upload": func(f *storedFixture, h *header.Header) {
			h.IncompletePendingUpload = true
			f.writeBuildHeader(storedParentID, storage.RootfsName, h)
		},
		"unaligned size": func(f *storedFixture, h *header.Header) {
			h.Metadata.Size++
			f.writeBuildHeader(storedParentID, storage.RootfsName, h)
		},
		"unaligned block size": func(f *storedFixture, h *header.Header) {
			h.Metadata.BlockSize++
			f.writeBuildHeader(storedParentID, storage.RootfsName, h)
		},
		"invalid coverage": func(f *storedFixture, h *header.Header) {
			h.Metadata.Version = 3
			h.Metadata.Size += header.PageSize
			f.writeBuildHeader(storedParentID, storage.RootfsName, h)
		},
		"unknown codec": func(f *storedFixture, h *header.Header) {
			h.SetBuild(uuid.MustParse(storedParentID), header.BuildData{FrameData: storage.NewFullFrameTable(99, []storage.FrameSize{{U: header.PageSize, C: 1}}).Table()})
			f.writeBuildHeader(storedParentID, storage.RootfsName, h)
		},
		"missing compressed data": func(f *storedFixture, _ *header.Header) {
			mustStored(f.t, os.Remove(filepath.Join(f.path, storedParentID, storage.RootfsName+storage.CompressionLZ4.Suffix())))
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStoredFixture(t, 5, storage.CompressionLZ4)
			delete(f.root.Builds, uuid.MustParse(storedParentID))
			f.writeHeader(storage.RootfsName, f.root)
			h := f.writeAncestorHeader(storage.RootfsName, 5, storage.CompressionLZ4)
			mutate(f, h)
			if refs, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID}); err == nil || refs != nil {
				t.Fatalf("invalid codec fallback accepted: %#v, %v", refs, err)
			}
		})
	}
}

func TestStoredReferencesFilesystemOnly(t *testing.T) {
	f := newStoredFixture(t, 5, storage.CompressionNone)
	if err := os.Remove(filepath.Join(f.path, storedRootID, storage.MemfileName+storage.HeaderSuffix)); err != nil {
		t.Fatal(err)
	}
	refs, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID, FilesystemOnly: true})
	if err != nil || len(refs) != 2 {
		t.Fatalf("filesystem references = %#v, %v", refs, err)
	}
	if refs, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID}); err == nil || refs != nil {
		t.Fatalf("full snapshot with missing memory accepted: %#v, %v", refs, err)
	}
}

func TestStoredReferencesRejectInvalidHeaders(t *testing.T) {
	tests := map[string]func(*storedFixture){
		"missing":   func(f *storedFixture) { mustStored(f.t, os.Remove(f.rootfsHeader())) },
		"truncated": func(f *storedFixture) { f.write(storedRootID, storage.RootfsName+storage.HeaderSuffix, []byte{1}) },
		"metadata only": func(f *storedFixture) {
			data, err := os.ReadFile(f.rootfsHeader())
			mustStored(f.t, err)
			f.write(storedRootID, storage.RootfsName+storage.HeaderSuffix, data[:binary.Size(header.Metadata{})])
		},
		"unknown version": func(f *storedFixture) {
			data, err := os.ReadFile(f.rootfsHeader())
			mustStored(f.t, err)
			binary.LittleEndian.PutUint64(data, 99)
			f.write(storedRootID, storage.RootfsName+storage.HeaderSuffix, data)
		},
		"unknown version bits": func(f *storedFixture) {
			data, err := os.ReadFile(f.rootfsHeader())
			mustStored(f.t, err)
			binary.LittleEndian.PutUint64(data, 1<<32|5)
			f.write(storedRootID, storage.RootfsName+storage.HeaderSuffix, data)
		},
		"wrong self ID": func(f *storedFixture) {
			f.root.Metadata.BuildId = uuid.MustParse(storedParentID)
			f.writeHeader(storage.RootfsName, f.root)
		},
		"zero block size": func(f *storedFixture) {
			f.root.Metadata.BlockSize = 0
			f.writeHeader(storage.RootfsName, f.root)
		},
		"invalid coverage": func(f *storedFixture) {
			// V5 intentionally reconstructs omitted ranges as zero-filled.
			// V3 stores explicit coverage, so this is a malformed V3 map.
			f.root.Metadata.Version = 3
			f.root.Metadata.Size += header.PageSize
			f.writeHeader(storage.RootfsName, f.root)
		},
		"incomplete upload": func(f *storedFixture) {
			f.root.IncompletePendingUpload = true
			f.writeHeader(storage.RootfsName, f.root)
		},
		"missing ancestor codec": func(f *storedFixture) {
			delete(f.root.Builds, uuid.MustParse(storedParentID))
			f.writeHeader(storage.RootfsName, f.root)
		},
		"unknown codec": func(f *storedFixture) {
			f.root.SetBuild(uuid.MustParse(storedParentID), header.BuildData{FrameData: storage.NewFullFrameTable(99, []storage.FrameSize{{U: header.PageSize, C: 1}}).Table()})
			f.writeHeader(storage.RootfsName, f.root)
			f.writeAncestorHeader(storage.RootfsName, 5, storage.CompressionNone)
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			f := newStoredFixture(t, 5, storage.CompressionNone)
			mutate(f)
			if refs, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID}); err == nil || refs != nil {
				t.Fatalf("invalid header accepted: %#v, %v", refs, err)
			}
		})
	}
}

func TestStoredReferencesLegacySelfCodec(t *testing.T) {
	f := newStoredFixture(t, 5, storage.CompressionNone)
	delete(f.root.Builds, uuid.MustParse(storedRootID))
	f.writeHeader(storage.RootfsName, f.root)
	if _, err := readStoredReferences(context.Background(), f.path, Root{BuildID: storedRootID}); err != nil {
		t.Fatalf("native legacy uncompressed self entry rejected: %v", err)
	}
}

func TestStoredReferencesRejectUnsafePaths(t *testing.T) {
	for _, target := range []string{"storage", "build", "header", "data", "data directory", "missing data"} {
		t.Run(target, func(t *testing.T) {
			f := newStoredFixture(t, 5, storage.CompressionNone)
			path := f.path
			switch target {
			case "storage":
				path = f.path + "-link"
				mustStored(t, os.Symlink(f.path, path))
				t.Cleanup(func() { _ = os.Remove(path) })
			case "build":
				build := filepath.Join(f.path, storedParentID)
				mustStored(t, os.Rename(build, build+"-real"))
				mustStored(t, os.Symlink(build+"-real", build))
			case "header":
				mustStored(t, os.Rename(f.rootfsHeader(), f.rootfsHeader()+"-real"))
				mustStored(t, os.Symlink(f.rootfsHeader()+"-real", f.rootfsHeader()))
			default:
				data := filepath.Join(f.path, storedParentID, storage.RootfsName)
				mustStored(t, os.Remove(data))
				if target == "data" {
					mustStored(t, os.Symlink(filepath.Join(f.path, storedRootID, storage.RootfsName), data))
				} else if target == "data directory" {
					mustStored(t, os.Mkdir(data, 0o700))
				}
			}
			if refs, err := readStoredReferences(context.Background(), path, Root{BuildID: storedRootID}); err == nil || refs != nil {
				t.Fatalf("unsafe path accepted: %#v, %v", refs, err)
			}
		})
	}
}

func TestStoredReferencesDoesNotCreateMissingBuild(t *testing.T) {
	path, err := filepath.EvalSymlinks(t.TempDir())
	mustStored(t, err)
	if refs, err := readStoredReferences(context.Background(), path, Root{BuildID: storedRootID}); err == nil || refs != nil {
		t.Fatalf("missing build accepted: %#v, %v", refs, err)
	}
	entries, err := os.ReadDir(path)
	mustStored(t, err)
	if len(entries) != 0 {
		t.Fatalf("read created files: %#v", entries)
	}
}

func TestStoredReferencesRejectNoncanonicalInput(t *testing.T) {
	f := newStoredFixture(t, 5, storage.CompressionNone)
	for _, path := range []string{".", f.path + "/.", f.path + "/../" + filepath.Base(f.path)} {
		if refs, err := readStoredReferences(context.Background(), path, Root{BuildID: storedRootID}); err == nil || refs != nil {
			t.Fatalf("noncanonical path %q accepted: %#v, %v", path, refs, err)
		}
	}
	for _, id := range []string{"../escape", uuid.Nil.String(), strings.ToUpper(storedRootID[:8]) + storedRootID[8:] + "/"} {
		if refs, err := readStoredReferences(context.Background(), f.path, Root{BuildID: id}); err == nil || refs != nil {
			t.Fatalf("invalid build ID %q accepted: %#v, %v", id, refs, err)
		}
	}
}

func TestStoredReferencesCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if refs, err := readStoredReferences(ctx, "/does-not-exist", Root{BuildID: storedRootID}); !errors.Is(err, context.Canceled) || refs != nil {
		t.Fatalf("cancelled read = %#v, %v", refs, err)
	}
}

func mustStored(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
