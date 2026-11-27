package main

import (
	"context"
	"errors"
	"fmt"
)

type LayerRef struct {
	BuildID  string
	Artifact string
}

type Root struct {
	BuildID        string
	FilesystemOnly bool
}

// ReadReferences returns every data-layer reference in the root's flattened
// rootfs header and, for full snapshots, its memory header.
type ReadReferences func(context.Context, Root) ([]LayerRef, error)

// validBuildID accepts only canonical, non-nil UUIDs suitable as directory names.
func validBuildID(value string) bool {
	if len(value) != 36 {
		return false
	}
	nonzero := false
	for i := range len(value) {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if value[i] != '-' {
				return false
			}
			continue
		}
		c := value[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
		nonzero = nonzero || c != '0'
	}
	return nonzero
}

// Mark retains complete build directories. Flattened headers identify all data
// layers directly; their ancestors' headers are not required to read that data.
// An error returns no set that a caller could mistake for deletion permission.
func Mark(ctx context.Context, roots []Root, read ReadReferences) (map[string]struct{}, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if read == nil {
		return nil, errors.New("reference reader is required")
	}
	unique := make(map[string]Root, len(roots))
	order := make([]string, 0, len(roots))
	for _, root := range roots {
		if !validBuildID(root.BuildID) {
			return nil, fmt.Errorf("invalid root build ID %q", root.BuildID)
		}
		if prior, ok := unique[root.BuildID]; ok {
			root.FilesystemOnly = root.FilesystemOnly && prior.FilesystemOnly
		} else {
			order = append(order, root.BuildID)
		}
		unique[root.BuildID] = root
	}

	marked := make(map[string]struct{}, len(unique))
	for _, id := range order {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		refs, err := read(ctx, unique[id])
		if err != nil {
			return nil, fmt.Errorf("read references for build %s: %w", id, err)
		}
		marked[id] = struct{}{}
		for _, ref := range refs {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if !validBuildID(ref.BuildID) {
				return nil, fmt.Errorf("invalid referenced build ID %q in root %s", ref.BuildID, id)
			}
			if ref.Artifact != "rootfs" && ref.Artifact != "memory" {
				return nil, fmt.Errorf("invalid referenced artifact %q in root %s", ref.Artifact, id)
			}
			marked[ref.BuildID] = struct{}{}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return marked, nil
}
