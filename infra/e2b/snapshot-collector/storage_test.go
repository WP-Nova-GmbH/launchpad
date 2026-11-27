package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const (
	storageA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	storageB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	storageC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	storageD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	storageE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
)

func storageFixture(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func writeStorageLayer(t *testing.T, root, id string, files map[string]string) {
	t.Helper()
	if err := os.Mkdir(filepath.Join(root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(root, id, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func scanFixture(t *testing.T, root string) storageInventory {
	t.Helper()
	got, err := scanStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func requireStored(t *testing.T, root, id string) {
	t.Helper()
	if _, err := os.Lstat(filepath.Join(root, id)); err != nil {
		t.Fatalf("expected %s to remain: %v", id, err)
	}
}

func TestSweepRetainedAncestorIsExcludedBeforeAnyDeletion(t *testing.T) {
	root := storageFixture(t)
	writeStorageLayer(t, root, storageA, map[string]string{"rootfs.ext4.header": "orphan"})
	writeStorageLayer(t, root, storageB, map[string]string{"rootfs.ext4.zstd": "shared data", "rootfs.ext4.zstd.uncompressed-size": "100"})
	inventory := scanFixture(t, root)
	retained := map[string]struct{}{storageB: {}}
	var journal bytes.Buffer
	deleted, err := sweepStorage(context.Background(), root, inventory.Layers, retained, &journal, storageLockHeld)
	if err == nil || len(deleted) != 0 || journal.Len() != 0 {
		t.Fatalf("retained candidate authorized deletion: %v, %v, %s", deleted, err, journal.String())
	}
	requireStored(t, root, storageA)
	requireStored(t, root, storageB)
	deleted, err = sweepStorage(context.Background(), root, inventory.Layers[:1], retained, &journal, storageLockHeld)
	if err != nil || !reflect.DeepEqual(deleted, []string{storageA}) {
		t.Fatalf("orphan sweep = %v, %v", deleted, err)
	}
	requireStored(t, root, storageB)
	var events []string
	decoder := json.NewDecoder(&journal)
	for decoder.More() {
		var entry struct{ Event, BuildID string }
		if err := decoder.Decode(&entry); err != nil {
			t.Fatal(err)
		}
		if entry.BuildID != storageA {
			t.Fatalf("wrong journal identity: %+v", entry)
		}
		events = append(events, entry.Event)
	}
	if !reflect.DeepEqual(events, []string{"intent", "deleted"}) {
		t.Fatalf("journal events = %v", events)
	}
}

func TestSweepChangedLaterCandidatePreservesEveryDirectory(t *testing.T) {
	root := storageFixture(t)
	for _, id := range []string{storageA, storageB} {
		writeStorageLayer(t, root, id, map[string]string{"metadata.json": "original"})
	}
	inventory := scanFixture(t, root)
	if err := os.WriteFile(filepath.Join(root, storageB, "metadata.json"), []byte("changed candidate"), 0o600); err != nil {
		t.Fatal(err)
	}
	var journal bytes.Buffer
	deleted, err := sweepStorage(context.Background(), root, inventory.Layers, nil, &journal, storageLockHeld)
	if err == nil || len(deleted) != 0 || journal.Len() != 0 {
		t.Fatalf("stale scan authorized deletion: %v, %v", deleted, err)
	}
	requireStored(t, root, storageA)
	requireStored(t, root, storageB)
}

func TestScanKeepsUnknownEntriesAndSymlinksWithoutFollowingThem(t *testing.T) {
	root := storageFixture(t)
	outside := filepath.Join(storageFixture(t), "outside.txt")
	if err := os.WriteFile(outside, []byte("untouched"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeStorageLayer(t, root, storageA, map[string]string{"metadata.json": "known", "notes.txt": "unknown"})
	writeStorageLayer(t, root, storageB, nil)
	if err := os.Symlink(outside, filepath.Join(root, storageB, "rootfs.ext4")); err != nil {
		t.Fatal(err)
	}
	writeStorageLayer(t, root, storageC, map[string]string{"memfile.header": "partial native upload"})
	writeStorageLayer(t, root, storageD, nil)
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, storageE)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README"), []byte("unknown"), 0o600); err != nil {
		t.Fatal(err)
	}
	inventory := scanFixture(t, root)
	if len(inventory.Layers) != 2 || inventory.Layers[0].BuildID != storageC || inventory.Layers[1].BuildID != storageD {
		t.Fatalf("unsafe candidate inventory: %+v", inventory)
	}
	wantUnknown := []string{"README", filepath.Join(storageA, "notes.txt"), filepath.Join(storageB, "rootfs.ext4"), storageE}
	if !reflect.DeepEqual(inventory.Unknown, wantUnknown) {
		t.Fatalf("unknown = %v, want %v", inventory.Unknown, wantUnknown)
	}
	var journal bytes.Buffer
	if _, err := sweepStorage(context.Background(), root, inventory.Layers, nil, &journal, storageLockHeld); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{storageA, storageB, storageE} {
		requireStored(t, root, id)
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "untouched" {
		t.Fatalf("followed an outside link: %q, %v", data, err)
	}
}

type storageJournal struct {
	bytes.Buffer
	writes     int
	syncs      int
	failWrite  int
	failSync   int
	afterWrite func(int)
}

func (journal *storageJournal) Write(data []byte) (int, error) {
	journal.writes++
	if journal.writes == journal.failWrite {
		return 0, errors.New("journal unavailable")
	}
	n, err := journal.Buffer.Write(data)
	if journal.afterWrite != nil {
		journal.afterWrite(journal.writes)
	}
	return n, err
}

func (journal *storageJournal) Sync() error {
	journal.syncs++
	if journal.syncs == journal.failSync {
		return errors.New("journal sync failed")
	}
	return nil
}

func TestSweepIntentSyncFailurePreventsUnlink(t *testing.T) {
	root := storageFixture(t)
	writeStorageLayer(t, root, storageA, map[string]string{"snapfile": "saved"})
	journal := &storageJournal{failSync: 1}
	deleted, err := sweepStorage(context.Background(), root, scanFixture(t, root).Layers, nil, journal, storageLockHeld)
	if err == nil || len(deleted) != 0 {
		t.Fatalf("unsynced intent authorized unlink: %v, %v", deleted, err)
	}
	requireStored(t, root, storageA)
}

func TestSweepReceiptFailureStopsLaterDeletionAndFreshScanCanRetry(t *testing.T) {
	root := storageFixture(t)
	writeStorageLayer(t, root, storageA, map[string]string{"rootfs.ext4.header": "partial native upload"})
	writeStorageLayer(t, root, storageB, nil)
	journal := &storageJournal{failWrite: 2}
	deleted, err := sweepStorage(context.Background(), root, scanFixture(t, root).Layers, nil, journal, storageLockHeld)
	if err == nil || !reflect.DeepEqual(deleted, []string{storageA}) {
		t.Fatalf("receipt failure = %v, %v", deleted, err)
	}
	requireStored(t, root, storageB)
	remaining := scanFixture(t, root)
	if len(remaining.Layers) != 1 || remaining.Layers[0].BuildID != storageB {
		t.Fatalf("retry inventory = %+v", remaining)
	}
	deleted, err = sweepStorage(context.Background(), root, remaining.Layers, nil, &storageJournal{}, storageLockHeld)
	if err != nil || !reflect.DeepEqual(deleted, []string{storageB}) {
		t.Fatalf("fresh retry = %v, %v", deleted, err)
	}
}

func TestSweepCancellationStopsAfterCurrentReceipt(t *testing.T) {
	root := storageFixture(t)
	for _, id := range []string{storageA, storageB} {
		writeStorageLayer(t, root, id, nil)
	}
	ctx, cancel := context.WithCancel(context.Background())
	journal := &storageJournal{afterWrite: func(write int) {
		if write == 2 {
			cancel()
		}
	}}
	deleted, err := sweepStorage(ctx, root, scanFixture(t, root).Layers, nil, journal, storageLockHeld)
	if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(deleted, []string{storageA}) {
		t.Fatalf("cancel = %v, %v", deleted, err)
	}
	requireStored(t, root, storageB)
	if journal.writes != 2 {
		t.Fatalf("cancellation allowed later intent: %d writes", journal.writes)
	}
}

func TestSweepRechecksCandidateAfterIntent(t *testing.T) {
	root := storageFixture(t)
	writeStorageLayer(t, root, storageA, map[string]string{"metadata.json": "old"})
	journal := &storageJournal{afterWrite: func(write int) {
		if write == 1 {
			if err := os.WriteFile(filepath.Join(root, storageA, "metadata.json"), []byte("changed during intent"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}}
	deleted, err := sweepStorage(context.Background(), root, scanFixture(t, root).Layers, nil, journal, storageLockHeld)
	if err == nil || len(deleted) != 0 {
		t.Fatalf("change during journal authorized unlink: %v, %v", deleted, err)
	}
	requireStored(t, root, storageA)
}

func TestStorageRejectsSymlinkRoot(t *testing.T) {
	root := storageFixture(t)
	link := filepath.Join(storageFixture(t), "linked-root")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	if _, err := scanStorage(link); err == nil {
		t.Fatal("symlink root was accepted")
	}
	if _, err := sweepStorage(context.Background(), link, nil, nil, &bytes.Buffer{}, storageLockHeld); err == nil {
		t.Fatal("symlink root was accepted for deletion")
	}
}

func storageLockHeld(context.Context) error { return nil }

func TestSweepLostCatalogueLockPreventsUnlink(t *testing.T) {
	root := storageFixture(t)
	for _, id := range []string{storageA, storageB} {
		writeStorageLayer(t, root, id, map[string]string{"metadata.json": "saved"})
	}
	journal := &storageJournal{}
	lost := errors.New("catalogue session ended")
	checks := 0
	deleted, err := sweepStorage(context.Background(), root, scanFixture(t, root).Layers, nil, journal, func(context.Context) error {
		checks++
		if journal.syncs != 1 {
			t.Fatal("lock checked before durable deletion intent")
		}
		return lost
	})
	if !errors.Is(err, lost) || len(deleted) != 0 || checks != 1 {
		t.Fatalf("lost lock authorized unlink: %v, %v, %d checks", deleted, err, checks)
	}
	for _, id := range []string{storageA, storageB} {
		requireStored(t, root, id)
	}
	if journal.writes != 1 {
		t.Fatalf("lost lock allowed later deletion intent: %d writes", journal.writes)
	}
}

func TestSweepRequiresLiveCatalogueLockCheck(t *testing.T) {
	root := storageFixture(t)
	writeStorageLayer(t, root, storageA, nil)
	var journal bytes.Buffer
	deleted, err := sweepStorage(context.Background(), root, scanFixture(t, root).Layers, nil, &journal, nil)
	if err == nil || len(deleted) != 0 || journal.Len() != 0 {
		t.Fatalf("missing lock check authorized deletion: %v, %v", deleted, err)
	}
	requireStored(t, root, storageA)
}
