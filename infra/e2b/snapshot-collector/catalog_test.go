package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestParseCatalogInventoryPreservesNativeRootKinds(t *testing.T) {
	const a = "11111111-1111-4111-8111-111111111111"
	const b = "22222222-2222-4222-8222-222222222222"
	input := catalogInventory{
		SchemaVersion: 1,
		Roots: []catalogRoot{
			{b, true, "paused-snapshot-assignment"},
			{a, false, "template-assignment"},
			{a, true, "snapshot-template"},
			{b, false, "unfinished-build"},
			{b, false, "active-build"},
			{a, false, "template-assignment"},
		},
		UnfinishedBuildIDs: []string{b, b},
		Issues:             []catalogIssue{{"snapshot-record-missing", "retained-snapshot"}},
	}
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseCatalogInventory(data)
	if err != nil {
		t.Fatal(err)
	}
	want := catalogInventory{
		SchemaVersion: 1,
		Roots: []catalogRoot{
			{a, true, "snapshot-template"},
			{a, false, "template-assignment"},
			{b, false, "active-build"},
			{b, true, "paused-snapshot-assignment"},
			{b, false, "unfinished-build"},
		},
		UnfinishedBuildIDs: []string{b},
		Issues:             input.Issues,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestParseCatalogInventoryRejectsIncompleteOrAmbiguousInput(t *testing.T) {
	const empty = `{"schemaVersion":1,"roots":[],"unfinishedBuildIds":[],"issues":[]}`
	const id = "11111111-1111-4111-8111-111111111111"
	for name, input := range map[string]string{
		"empty":                      "",
		"null":                       "null",
		"missing roots":              `{"schemaVersion":1,"unfinishedBuildIds":[],"issues":[]}`,
		"null array":                 strings.Replace(empty, `"roots":[]`, `"roots":null`, 1),
		"unknown field":              strings.Replace(empty, `"schemaVersion":1`, `"schemaVersion":1,"complete":true`, 1),
		"version":                    strings.Replace(empty, `"schemaVersion":1`, `"schemaVersion":2`, 1),
		"extra object":               empty + empty,
		"trailing garbage":           empty + "psql failed",
		"bad UUID":                   strings.Replace(empty, `"roots":[]`, `"roots":[{"buildId":"../../data","filesystemOnly":false,"reason":"template-assignment"}]`, 1),
		"nil UUID":                   strings.Replace(empty, `"roots":[]`, `"roots":[{"buildId":"00000000-0000-0000-0000-000000000000","filesystemOnly":false,"reason":"template-assignment"}]`, 1),
		"missing filesystem kind":    strings.Replace(empty, `"roots":[]`, `"roots":[{"buildId":"`+id+`","reason":"template-assignment"}]`, 1),
		"null filesystem kind":       strings.Replace(empty, `"roots":[]`, `"roots":[{"buildId":"`+id+`","filesystemOnly":null,"reason":"template-assignment"}]`, 1),
		"unknown root":               strings.Replace(empty, `"roots":[]`, `"roots":[{"buildId":"`+id+`","filesystemOnly":false,"reason":"live-cache"}]`, 1),
		"unfinished ID missing root": strings.Replace(empty, `"unfinishedBuildIds":[]`, `"unfinishedBuildIds":["`+id+`"]`, 1),
		"unfinished root missing ID": strings.Replace(empty, `"roots":[]`, `"roots":[{"buildId":"`+id+`","filesystemOnly":false,"reason":"unfinished-build"}]`, 1),
		"unknown issue":              strings.Replace(empty, `"issues":[]`, `"issues":[{"kind":"whatever","recordId":"x"}]`, 1),
		"missing issue record":       strings.Replace(empty, `"issues":[]`, `"issues":[{"kind":"snapshot-record-missing"}]`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := parseCatalogInventory([]byte(input))
			if err == nil {
				t.Fatalf("accepted unsafe inventory: %#v", got)
			}
			if !reflect.DeepEqual(got, catalogInventory{}) {
				t.Fatalf("error returned partial inventory: %#v", got)
			}
		})
	}
	got, err := parseCatalogInventory([]byte(" \n" + empty + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Roots) != 0 || len(got.UnfinishedBuildIDs) != 0 || len(got.Issues) != 0 {
		t.Fatalf("unexpected empty inventory: %#v", got)
	}
}
