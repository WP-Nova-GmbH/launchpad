package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/e2b-dev/infra/packages/shared/pkg/storage"
	"github.com/e2b-dev/infra/packages/shared/pkg/storage/header"
	"github.com/google/uuid"
)

const (
	collectionSecondRoot = "33333333-3333-4333-8333-333333333333"
	collectionMemoryOnly = "44444444-4444-4444-8444-444444444444"
	collectionUnused     = "55555555-5555-4555-8555-555555555555"
)

type collectionFixture struct {
	stored   *storedFixture
	config   cleanupConfig
	catalog  catalogInventory
	expected map[string]map[string][]byte
}

func newCollectionFixture(t *testing.T) collectionFixture {
	t.Helper()
	f := newStoredFixture(t, header.MetadataVersionV5, storage.CompressionNone)
	page := func(value byte) []byte { return bytes.Repeat([]byte{value}, int(header.PageSize)) }
	a, b, shared, memory, r := page('A'), page('B'), page('S'), page('M'), page('R')
	f.write(storedRootID, storage.RootfsName, a)
	f.write(storedParentID, storage.RootfsName, shared)
	f.write(collectionMemoryOnly, storage.MemfileName, memory)
	f.write(collectionSecondRoot, storage.RootfsName, b)
	f.write(collectionSecondRoot, storage.MemfileName, r)
	writeHeader := func(id, name string, mappings []header.BuildMap) {
		t.Helper()
		var size uint64
		for _, mapping := range mappings {
			size += mapping.Length
		}
		meta := header.NewTemplateMetadata(uuid.MustParse(id), header.PageSize, size)
		meta.Version = header.MetadataVersionV5
		h, err := header.NewHeader(meta, mappings)
		mustStored(t, err)
		for _, mapping := range mappings {
			if mapping.BuildId != uuid.Nil {
				h.SetBuild(mapping.BuildId, header.BuildData{})
			}
		}
		data, err := header.SerializeHeader(h)
		mustStored(t, err)
		f.write(id, name+storage.HeaderSuffix, data)
	}
	writeHeader(storedRootID, storage.MemfileName, []header.BuildMap{
		{Length: header.PageSize, BuildId: uuid.MustParse(collectionMemoryOnly)},
	})
	writeHeader(collectionSecondRoot, storage.RootfsName, []header.BuildMap{
		{Length: header.PageSize, BuildId: uuid.MustParse(collectionSecondRoot)},
		{Offset: header.PageSize, Length: header.PageSize, BuildId: uuid.MustParse(storedParentID)},
	})
	writeHeader(collectionSecondRoot, storage.MemfileName, []header.BuildMap{
		{Length: header.PageSize, BuildId: uuid.MustParse(collectionMemoryOnly)},
		{Offset: header.PageSize, Length: header.PageSize, BuildId: uuid.MustParse(collectionSecondRoot)},
	})
	// A partially uploaded native build is collectible only because nothing
	// references it and the fixture supplies an externally frozen writer context.
	f.write(collectionUnused, "metadata.json", []byte(`{"unused":true}`))
	f.write(collectionUnused, "snapfile", []byte("unused native VM state"))
	config := validCleanupConfig()
	config.StoragePath = f.path
	config.BuildCachePath = storageFixture(t)
	config.JournalPath = filepath.Join(storageFixture(t), "collection.jsonl")
	return collectionFixture{
		stored: f,
		config: config,
		catalog: catalogInventory{SchemaVersion: 1, Roots: []catalogRoot{
			{BuildID: storedRootID}, {BuildID: collectionSecondRoot},
		}},
		expected: map[string]map[string][]byte{
			storedRootID: {
				storage.RootfsName:  bytes.Join([][]byte{a, shared, make([]byte, header.PageSize)}, nil),
				storage.MemfileName: memory,
			},
			collectionSecondRoot: {
				storage.RootfsName:  bytes.Join([][]byte{b, shared}, nil),
				storage.MemfileName: bytes.Join([][]byte{memory, r}, nil),
			},
		},
	}
}

// This reads tiny uncompressed fixture objects through the upstream serialized
// map. It checks byte reachability; a real VM restore is a separate proof.
func reconstructCollectionArtifact(t *testing.T, path, id, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(path, id, name+storage.HeaderSuffix))
	mustStored(t, err)
	h, err := header.DeserializeBytes(data)
	mustStored(t, err)
	if h.Metadata.Size > 1<<20 {
		t.Fatal("fixture exceeds its one MiB bound")
	}
	result := make([]byte, h.Metadata.Size)
	for _, mapping := range h.Mapping.All() {
		if mapping.BuildId == uuid.Nil {
			continue
		}
		if h.Builds[mapping.BuildId].FrameData.CompressionType() != storage.CompressionNone {
			t.Fatal("integration fixture must contain uncompressed objects")
		}
		object, err := os.ReadFile(filepath.Join(path, mapping.BuildId.String(), name))
		mustStored(t, err)
		end := mapping.BuildStorageOffset + mapping.Length
		if end > uint64(len(object)) || mapping.Offset+mapping.Length > uint64(len(result)) {
			t.Fatal("fixture map extends beyond its data object")
		}
		copy(result[mapping.Offset:mapping.Offset+mapping.Length], object[mapping.BuildStorageOffset:end])
	}
	return result
}

func (fixture collectionFixture) requireMappedBytes(t *testing.T) {
	t.Helper()
	for id, artifacts := range fixture.expected {
		for name, expected := range artifacts {
			if got := reconstructCollectionArtifact(t, fixture.stored.path, id, name); !bytes.Equal(got, expected) {
				t.Fatalf("mapped %s bytes changed for %s", name, id)
			}
		}
	}
}

func TestCollectionReportOnlyAndApplyPreserveSharedDiskAndMemoryBytes(t *testing.T) {
	fixture := newCollectionFixture(t)
	fixture.requireMappedBytes(t)
	var total int64
	mustStored(t, filepath.WalkDir(fixture.stored.path, func(path string, item fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !item.IsDir() {
			info, err := item.Info()
			if err != nil {
				return err
			}
			total += info.Size()
		}
		return nil
	}))
	if total >= 1<<20 {
		t.Fatalf("fixture unexpectedly large: %d bytes", total)
	}
	report, candidates, retained, err := planCollection(context.Background(), fixture.config, fixture.catalog, nil, time.Now().Add(2*time.Hour))
	mustStored(t, err)
	if !report.DryRun || report.RetainedLayers != 4 || len(report.DeletedIDs) != 0 ||
		!reflect.DeepEqual(report.CandidateIDs, []string{collectionUnused}) || len(candidates) != 1 {
		t.Fatalf("unsafe report-only plan: %+v, candidates %+v", report, candidates)
	}
	for _, id := range []string{storedRootID, storedParentID, collectionSecondRoot, collectionMemoryOnly, collectionUnused} {
		requireStored(t, fixture.stored.path, id)
	}
	if _, err := os.Stat(fixture.config.JournalPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("report-only planning opened a deletion journal: %v", err)
	}
	for _, id := range []string{storedRootID, storedParentID, collectionSecondRoot, collectionMemoryOnly} {
		if _, exists := retained[id]; !exists {
			t.Fatalf("plan lost reachable layer %s", id)
		}
	}
	if report.CandidateBytes != candidates[0].AllocatedBytes {
		t.Fatalf("reported reclaimable bytes differ from scanned candidate: %+v", report)
	}
	before := scanFixture(t, fixture.stored.path)
	journal, err := openJournal(fixture.config.JournalPath)
	mustStored(t, err)
	checks := 0
	deleted, sweepErr := sweepStorage(context.Background(), fixture.stored.path, candidates, retained, journal, func(context.Context) error {
		checks++
		return nil
	})
	closeErr := journal.Close()
	mustStored(t, errors.Join(sweepErr, closeErr))
	if !reflect.DeepEqual(deleted, []string{collectionUnused}) || checks != 1 {
		t.Fatalf("physical sweep = %v, %d lock checks", deleted, checks)
	}
	if _, err := os.Lstat(filepath.Join(fixture.stored.path, collectionUnused)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("claimed deletion still exists: %v", err)
	}
	after := scanFixture(t, fixture.stored.path)
	allocated := func(inventory storageInventory) int64 {
		var n int64
		for _, layer := range inventory.Layers {
			n += layer.AllocatedBytes
		}
		return n
	}
	if actual := allocated(before) - allocated(after); actual != report.CandidateBytes {
		t.Fatalf("physical inventory reclaimed %d bytes, report promised %d", actual, report.CandidateBytes)
	}
	fixture.requireMappedBytes(t)
	journalBytes, err := os.ReadFile(fixture.config.JournalPath)
	mustStored(t, err)
	decoder := json.NewDecoder(bytes.NewReader(journalBytes))
	var events []string
	for {
		var entry struct {
			Event          string `json:"event"`
			BuildID        string `json:"buildId"`
			AllocatedBytes int64  `json:"allocatedBytes"`
			LogicalBytes   int64  `json:"logicalBytes"`
			Fingerprint    string `json:"fingerprint"`
		}
		err := decoder.Decode(&entry)
		if errors.Is(err, io.EOF) {
			break
		}
		mustStored(t, err)
		if entry.BuildID != collectionUnused || entry.AllocatedBytes != candidates[0].AllocatedBytes ||
			entry.LogicalBytes != candidates[0].LogicalBytes || entry.Fingerprint != candidates[0].fingerprint {
			t.Fatalf("journal receipt does not identify reclaimed data: %+v", entry)
		}
		events = append(events, entry.Event)
	}
	if !reflect.DeepEqual(events, []string{"intent", "deleted"}) {
		t.Fatalf("deletion journal = %v", events)
	}
}

func TestCollectionMissingRetainedMemoryHeaderAuthorizesNoApply(t *testing.T) {
	fixture := newCollectionFixture(t)
	mustStored(t, os.Remove(filepath.Join(fixture.stored.path, storedRootID, storage.MemfileName+storage.HeaderSuffix)))
	report, candidates, retained, err := planCollection(context.Background(), fixture.config, fixture.catalog, nil, time.Now().Add(2*time.Hour))
	if err == nil || candidates != nil || retained != nil || len(report.CandidateIDs) != 0 {
		t.Fatalf("missing retained memory header authorized collection: %+v, %v", report, err)
	}
	for _, id := range []string{storedRootID, storedParentID, collectionSecondRoot, collectionMemoryOnly, collectionUnused} {
		requireStored(t, fixture.stored.path, id)
	}
}

func TestCollectionAncestorCodecFallbackPreservesSharedBytes(t *testing.T) {
	fixture := newCollectionFixture(t)
	delete(fixture.stored.root.Builds, uuid.MustParse(storedParentID))
	fixture.stored.writeHeader(storage.RootfsName, fixture.stored.root)
	metadata := header.NewTemplateMetadata(uuid.MustParse(storedParentID), header.PageSize, header.PageSize)
	metadata.Version = 3
	ancestor, err := header.NewHeader(metadata, nil)
	mustStored(t, err)
	data, err := header.SerializeHeader(ancestor)
	mustStored(t, err)
	fixture.stored.write(storedParentID, storage.RootfsName+storage.HeaderSuffix, data)
	fixture.requireMappedBytes(t)
	report, candidates, retained, err := planCollection(context.Background(), fixture.config, fixture.catalog, nil, time.Now().Add(2*time.Hour))
	mustStored(t, err)
	if !reflect.DeepEqual(report.CandidateIDs, []string{collectionUnused}) {
		t.Fatalf("fallback selected reachable layers: %+v", report)
	}
	var journal bytes.Buffer
	deleted, err := sweepStorage(context.Background(), fixture.stored.path, candidates, retained, &journal, storageLockHeld)
	mustStored(t, err)
	if !reflect.DeepEqual(deleted, []string{collectionUnused}) {
		t.Fatalf("fallback prevented unused-layer collection: %v", deleted)
	}
	fixture.requireMappedBytes(t)
	for _, id := range []string{storedRootID, storedParentID, collectionSecondRoot, collectionMemoryOnly} {
		requireStored(t, fixture.stored.path, id)
	}
}

func TestCollectionChangedCandidateCannotApplyStalePlan(t *testing.T) {
	fixture := newCollectionFixture(t)
	_, candidates, retained, err := planCollection(context.Background(), fixture.config, fixture.catalog, nil, time.Now().Add(2*time.Hour))
	mustStored(t, err)
	fixture.stored.write(collectionUnused, "metadata.json", []byte(`{"changedSincePlan":true}`))
	var journal bytes.Buffer
	deleted, err := sweepStorage(context.Background(), fixture.stored.path, candidates, retained, &journal, storageLockHeld)
	if err == nil || len(deleted) != 0 || journal.Len() != 0 {
		t.Fatalf("changed candidate was reclaimed: %v, %v", deleted, err)
	}
	requireStored(t, fixture.stored.path, collectionUnused)
	fixture.requireMappedBytes(t)
}
