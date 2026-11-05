package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"github.com/e2b-dev/infra/packages/shared/pkg/storage"
	"github.com/e2b-dev/infra/packages/shared/pkg/storage/header"
	"github.com/google/uuid"
)

// Native V4/V5 headers already cap decompressed mappings at 256 MiB. Bound
// stored input too, including legacy V3, before handing it to the native parser.
const maxStoredHeaderBytes = 257 << 20

func readStoredReferences(ctx context.Context, storagePath string, root Root) ([]LayerRef, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validBuildID(root.BuildID) {
		return nil, fmt.Errorf("invalid root build ID %q", root.BuildID)
	}
	store, err := openHeaderStorage(storagePath)
	if err != nil {
		return nil, err
	}
	defer store.Close()

	artifacts := []struct{ name, kind string }{{storage.RootfsName, "rootfs"}}
	if !root.FilesystemOnly {
		artifacts = append(artifacts, struct{ name, kind string }{storage.MemfileName, "memory"})
	}
	var refs []LayerRef
	for _, artifact := range artifacts {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		ids, err := readArtifactReferences(ctx, store, root.BuildID, artifact.name)
		if err != nil {
			return nil, fmt.Errorf("read %s references for %s: %w", artifact.kind, root.BuildID, err)
		}
		for _, id := range ids {
			refs = append(refs, LayerRef{BuildID: id, Artifact: artifact.kind})
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return refs, nil
}

func readArtifactReferences(ctx context.Context, store *os.Root, buildID, name string) ([]string, error) {
	h, err := readStoredHeader(ctx, store, buildID, name)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(h.Mapping.Builds()))
	for _, id := range h.Mapping.Builds() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if id == uuid.Nil {
			continue // Native zero-filled regions do not read a data object.
		}
		codec, err := storedLayerCodec(ctx, store, h, id, name)
		if err != nil {
			return nil, err
		}
		layer, err := openStoredBuild(store, id.String())
		if err != nil {
			return nil, err
		}
		object, err := openStoredRegular(layer, name+codec.Suffix())
		bd, hasEntry := h.Builds[id]
		if errors.Is(err, fs.ErrNotExist) && h.Metadata.Version >= header.MetadataVersionV4 &&
			id != h.Metadata.BuildId && hasEntry && bd == (header.BuildData{}) {
			// Native reads repair an old uncompressed placeholder when the basic
			// object is absent. Resolve from the ancestor's own stored header.
			var ancestor *header.Header
			ancestor, err = readStoredHeader(ctx, store, id.String(), name)
			if err == nil {
				codec, err = storedLayerCodec(ctx, store, ancestor, id, name)
			}
			if err == nil {
				object, err = openStoredRegular(layer, name+codec.Suffix())
			}
		}
		layer.Close()
		if err != nil {
			return nil, fmt.Errorf("mapped data for %s: %w", id, err)
		}
		object.Close()
		ids = append(ids, id.String())
	}
	sort.Strings(ids)
	return ids, nil
}

func storedLayerCodec(ctx context.Context, store *os.Root, h *header.Header, id uuid.UUID, name string) (storage.CompressionType, error) {
	codec := storage.CompressionNone
	if h.Metadata.Version >= header.MetadataVersionV4 {
		bd, exists := h.Builds[id]
		if !exists && id != h.Metadata.BuildId {
			ancestor, err := readStoredHeader(ctx, store, id.String(), name)
			if err != nil {
				return codec, fmt.Errorf("read compression metadata for layer %s: %w", id, err)
			}
			// Only the ancestor's own codec is needed. Its flattened mappings
			// describe a different start target, so do not traverse them here.
			bd = ancestor.Builds[id]
		}
		// Native legacy runV3 can write V4/V5 with a missing self entry;
		// that case authoritatively means uncompressed, as does a V3 header.
		codec = bd.FrameData.CompressionType()
	}
	if codec != storage.CompressionNone && codec != storage.CompressionZstd && codec != storage.CompressionLZ4 {
		return codec, fmt.Errorf("unsupported compression type %d for layer %s", codec, id)
	}
	return codec, nil
}

func readStoredHeader(ctx context.Context, store *os.Root, buildID, name string) (*header.Header, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	build, err := openStoredBuild(store, buildID)
	if err != nil {
		return nil, err
	}
	defer build.Close()
	f, err := openStoredRegular(build, name+storage.HeaderSuffix)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxStoredHeaderBytes+1))
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// The native V3 parser treats a metadata-only file as an identity map. A
	// collector must not infer references from a truncated stored header.
	if len(data) <= binary.Size(header.Metadata{}) || len(data) > maxStoredHeaderBytes {
		return nil, errors.New("missing mappings or oversized stored header")
	}
	h, err := header.DeserializeBytes(data)
	if err != nil {
		return nil, fmt.Errorf("deserialize native header: %w", err)
	}
	if h.Metadata == nil || h.Metadata.BuildId.String() != buildID {
		return nil, errors.New("header build ID does not match its directory")
	}
	if h.Metadata.Version < 1 || h.Metadata.Version > header.MetadataVersionV5 {
		return nil, fmt.Errorf("unsupported header version %d", h.Metadata.Version)
	}
	if h.IncompletePendingUpload {
		return nil, errors.New("stored header has an incomplete upload")
	}
	if h.Metadata.Size == 0 || h.Metadata.Size%header.PageSize != 0 ||
		h.Metadata.BlockSize == 0 || h.Metadata.BlockSize%header.PageSize != 0 {
		return nil, errors.New("invalid header size or block size")
	}
	// Memory dirty-tracking can use hugepages, while flattened mappings remain
	// page-granular. Validate with native PageSize, not Metadata.BlockSize.
	if err := h.Mapping.Validate(h.Metadata.Size, header.PageSize); err != nil {
		return nil, fmt.Errorf("invalid native block map: %w", err)
	}
	for _, mapping := range h.Mapping.All() {
		if mapping.Length == 0 {
			return nil, errors.New("native block map contains an empty mapping")
		}
	}

	return h, nil
}

func openHeaderStorage(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("storage path must be canonical and absolute")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if resolved != path {
		return nil, errors.New("storage path must not contain symlinks")
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("storage path must be a non-symlink directory")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	after, err := root.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		root.Close()
		return nil, errors.New("storage directory changed while opening")
	}
	return root, nil
}

func openStoredBuild(store *os.Root, id string) (*os.Root, error) {
	if !validBuildID(id) {
		return nil, fmt.Errorf("invalid referenced build ID %q", id)
	}
	before, err := store.Lstat(id)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("build %s is not a non-symlink directory", id)
	}
	build, err := store.OpenRoot(id)
	if err != nil {
		return nil, err
	}
	after, err := build.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		build.Close()
		return nil, fmt.Errorf("build %s changed while opening", id)
	}
	return build, nil
}

func openStoredRegular(build *os.Root, name string) (*os.File, error) {
	before, err := build.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular non-symlink file", name)
	}
	f, err := build.Open(name)
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		f.Close()
		return nil, fmt.Errorf("%s changed while opening", name)
	}
	return f, nil
}
