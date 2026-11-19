package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

const (
	markRootA  = "11111111-1111-4111-8111-111111111111"
	markRootB  = "22222222-2222-4222-8222-222222222222"
	markShared = "33333333-3333-4333-8333-333333333333"
	markMemory = "44444444-4444-4444-8444-444444444444"
)

func TestMarkRetainsSharedDiskAndMemoryLayersWithoutReadingAncestorHeaders(t *testing.T) {
	roots := []Root{{BuildID: markRootA}, {BuildID: markRootB, FilesystemOnly: true}}
	calls := make(map[string]int)
	got, err := Mark(context.Background(), roots, func(_ context.Context, root Root) ([]LayerRef, error) {
		calls[root.BuildID]++
		switch root.BuildID {
		case markRootA:
			return []LayerRef{{BuildID: markShared, Artifact: "rootfs"}, {BuildID: markMemory, Artifact: "memory"}}, nil
		case markRootB:
			return []LayerRef{{BuildID: markShared, Artifact: "rootfs"}}, nil
		default:
			t.Fatalf("ancestor header must not be read: %s", root.BuildID)
			return nil, nil
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]struct{}{markRootA: {}, markRootB: {}, markShared: {}, markMemory: {}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("marked = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(calls, map[string]int{markRootA: 1, markRootB: 1}) {
		t.Fatalf("reads = %v", calls)
	}
}

func TestMarkMissingRootDiscardsEarlierMarks(t *testing.T) {
	missing := errors.New("root header is missing")
	got, err := Mark(context.Background(), []Root{{BuildID: markRootA}, {BuildID: markRootB}},
		func(_ context.Context, root Root) ([]LayerRef, error) {
			if root.BuildID == markRootB {
				return nil, missing
			}
			return []LayerRef{{BuildID: markShared, Artifact: "rootfs"}}, nil
		})
	if got != nil || !errors.Is(err, missing) {
		t.Fatalf("got (%v, %v), want no marks and original error", got, err)
	}
}

func TestMarkDuplicateRootsReadOnceWithFullSnapshotWinning(t *testing.T) {
	for _, roots := range [][]Root{
		{{BuildID: markRootA, FilesystemOnly: true}, {BuildID: markRootA}, {BuildID: markRootA, FilesystemOnly: true}},
		{{BuildID: markRootA}, {BuildID: markRootA, FilesystemOnly: true}},
	} {
		calls := 0
		got, err := Mark(context.Background(), roots, func(_ context.Context, root Root) ([]LayerRef, error) {
			calls++
			if root.FilesystemOnly {
				t.Fatal("full snapshot was downgraded")
			}
			return []LayerRef{{BuildID: markMemory, Artifact: "memory"}}, nil
		})
		if err != nil || calls != 1 {
			t.Fatalf("reads = %d, err = %v", calls, err)
		}
		if _, ok := got[markMemory]; !ok {
			t.Fatal("memory-only dependency was dropped")
		}
	}
}

func TestMarkRejectsInvalidRootAndLayerIDs(t *testing.T) {
	for _, bad := range []string{"", "00000000-0000-0000-0000-000000000000", "../" + markRootA,
		strings.ToUpper("abcdefab-cdef-4abc-8abc-abcdefabcdef"), "11111111111141118111111111111111"} {
		t.Run(bad, func(t *testing.T) {
			called := false
			got, err := Mark(context.Background(), []Root{{BuildID: bad}}, func(context.Context, Root) ([]LayerRef, error) {
				called = true
				return nil, nil
			})
			if got != nil || err == nil || called {
				t.Fatalf("invalid root produced (%v, %v), read=%v", got, err, called)
			}
			got, err = Mark(context.Background(), []Root{{BuildID: markRootA}}, func(context.Context, Root) ([]LayerRef, error) {
				return []LayerRef{{BuildID: bad, Artifact: "rootfs"}}, nil
			})
			if got != nil || err == nil {
				t.Fatalf("invalid reference produced (%v, %v)", got, err)
			}
		})
	}
}

func TestMarkCancellationDiscardsMarksEvenWhenReaderIgnoresContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	got, err := Mark(ctx, []Root{{BuildID: markRootA}}, func(context.Context, Root) ([]LayerRef, error) {
		cancel()
		return nil, nil
	})
	if got != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("got (%v, %v), want cancellation and no marks", got, err)
	}
}

func TestMarkRejectsUnknownArtifact(t *testing.T) {
	got, err := Mark(context.Background(), []Root{{BuildID: markRootA}}, func(context.Context, Root) ([]LayerRef, error) {
		return []LayerRef{{BuildID: markShared, Artifact: "../memory"}}, nil
	})
	if got != nil || err == nil {
		t.Fatalf("unknown artifact produced (%v, %v)", got, err)
	}
}
