package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func maintenanceFixture(t *testing.T) (cleanupConfig, deployment, []dockerContainer) {
	t.Helper()
	config, cs := stockDockerFixture(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config.JournalPath = filepath.Join(base, "cleanup.jsonl")
	d, err := validateDeployment(config, cs, cs)
	if err != nil {
		t.Fatal(err)
	}
	if err := beginMaintenance(config, d); err != nil {
		t.Fatal(err)
	}
	return config, d, cs
}

func TestMaintenanceIntentAndRestorationAreDurable(t *testing.T) {
	config, d, _ := maintenanceFixture(t)
	receipt, exists, err := readMaintenance(config)
	if err != nil || !exists || receipt.Phase != "pending" || len(receipt.AttemptedStopIDs) != 0 {
		t.Fatalf("missing initial receipt: %#v %t %v", receipt, exists, err)
	}
	if err := recordMaintenanceStop(config, d.Writers); err != nil {
		t.Fatal(err)
	}
	ids := append(slices.Clone(d.Writers), d.Orchestrator)
	if err := recordMaintenanceStop(config, ids); err != nil {
		t.Fatal(err)
	}
	receipt, _, err = readMaintenance(config)
	if err != nil || !reflect.DeepEqual(receipt.AttemptedStopIDs, ids) {
		t.Fatalf("stop intent missing: %#v %v", receipt, err)
	}
	if err := recordMaintenanceStop(config, d.Writers); err == nil {
		t.Fatal("removed durable stop intent")
	}
	if err := markMaintenanceRestoring(config); err != nil {
		t.Fatal(err)
	}
	if err := recordMaintenanceStop(config, ids); err == nil {
		t.Fatal("allowed stop after restoration began")
	}
	if err := finishMaintenance(config); err != nil {
		t.Fatal(err)
	}
	receipt, _, err = readMaintenance(config)
	if err != nil || receipt.Phase != "restored" {
		t.Fatalf("restoration receipt missing: %#v %v", receipt, err)
	}
	if err := beginMaintenance(config, d); err != nil {
		t.Fatal("completed receipt prevented next pass", err)
	}
}

func TestMaintenanceCannotOverwriteAnUnfinishedWindow(t *testing.T) {
	config, d, _ := maintenanceFixture(t)
	if err := beginMaintenance(config, d); err == nil {
		t.Fatal("overwrote pending maintenance")
	}
	changed := config
	changed.StoragePath = "/different/templates"
	if _, _, err := readMaintenance(changed); err == nil {
		t.Fatal("accepted another storage profile")
	}
	path := maintenancePath(config)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "fixture-password") {
		t.Fatal("stored credentials in maintenance receipt")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readMaintenance(config); err == nil {
		t.Fatal("accepted non-private receipt")
	}
}

func TestMaintenanceReceiptRejectsSymlinksAndInvalidIdentities(t *testing.T) {
	config, _, _ := maintenanceFixture(t)
	path := maintenancePath(config)
	if err := os.Rename(path, path+".real"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path+".real", path); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readMaintenance(config); err == nil {
		t.Fatal("followed receipt symlink")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".real", path); err != nil {
		t.Fatal(err)
	}
	receipt, _, err := readMaintenance(config)
	if err != nil {
		t.Fatal(err)
	}
	receipt.AttemptedStopIDs = []string{strings.Repeat("f", 64)}
	if err := writeMaintenance(config, receipt); err == nil {
		t.Fatal("accepted unrecorded stop target")
	}
}

func TestRecordedRecoveryNeverStopsAfterRestorationBegan(t *testing.T) {
	config, d, _ := maintenanceFixture(t)
	ids := append(slices.Clone(d.Writers), d.Orchestrator)
	if err := recordMaintenanceStop(config, ids); err != nil {
		t.Fatal(err)
	}
	if err := markMaintenanceRestoring(config); err != nil {
		t.Fatal(err)
	}
	receipt, _, err := readMaintenance(config)
	if err != nil {
		t.Fatal(err)
	}
	f := hostFixture{t: t}
	host := f.host()
	host.stop = func(context.Context, []string) error {
		t.Fatal("stopped services during restoring recovery")
		return nil
	}
	if err := recoverRecordedMaintenance(context.Background(), config, receipt, host, true); err != nil {
		t.Fatal(err)
	}
	want := slices.Clone(ids)
	slices.Reverse(want)
	if !reflect.DeepEqual(f.starts, [][]string{want}) {
		t.Fatalf("replaced captured IDs: %#v", f.starts)
	}
	got, _, err := readMaintenance(config)
	if err != nil || got.Phase != "restored" {
		t.Fatalf("did not confirm recovered services: %#v %v", got, err)
	}
}

func TestPendingRecoverySettlesOnlyAttemptedWriterIDs(t *testing.T) {
	config, d, _ := maintenanceFixture(t)
	if err := recordMaintenanceStop(config, d.Writers); err != nil {
		t.Fatal(err)
	}
	receipt, _, err := readMaintenance(config)
	if err != nil {
		t.Fatal(err)
	}
	f := hostFixture{t: t}
	if err := recoverRecordedMaintenance(context.Background(), config, receipt, f.host(), true); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.stops, [][]string{d.Writers}) {
		t.Fatalf("settled an unattempted service: %#v", f.stops)
	}
	for _, id := range f.starts[0] {
		if id == d.Orchestrator {
			t.Fatal("touched unattempted running orchestrator")
		}
	}
}

func TestPendingRecoveryRefusesNewBusyOrUnknownOrchestrator(t *testing.T) {
	for _, kind := range []string{"busy", "unknown"} {
		t.Run(kind, func(t *testing.T) {
			config, d, _ := maintenanceFixture(t)
			if err := recordMaintenanceStop(config, append(slices.Clone(d.Writers), d.Orchestrator)); err != nil {
				t.Fatal(err)
			}
			receipt, _, err := readMaintenance(config)
			if err != nil {
				t.Fatal(err)
			}
			state := healthyNative()
			if kind == "busy" {
				state.RunningVMs = 1
			} else {
				state.Commit = "unknown"
			}
			f := hostFixture{t: t, states: []runtimeInventory{state}}
			if err := recoverRecordedMaintenance(context.Background(), config, receipt, f.host(), true); err == nil {
				t.Fatal("accepted busy or unsupported stop")
			}
			if len(f.stops) != 0 || len(f.starts) != 0 {
				t.Fatal("acted on a busy runtime")
			}
		})
	}
}

func TestFailedRecoveryLeavesRestoringReceiptForStartOnlyRetry(t *testing.T) {
	config, d, _ := maintenanceFixture(t)
	if err := recordMaintenanceStop(config, d.Writers); err != nil {
		t.Fatal(err)
	}
	receipt, _, err := readMaintenance(config)
	if err != nil {
		t.Fatal(err)
	}
	f := hostFixture{t: t, startError: errors.New("not healthy yet")}
	if err := recoverRecordedMaintenance(context.Background(), config, receipt, f.host(), true); err == nil {
		t.Fatal("claimed failed restart was healthy")
	}
	got, _, err := readMaintenance(config)
	if err != nil || got.Phase != "restoring" {
		t.Fatalf("lost start-only retry marker: %#v %v", got, err)
	}
}

func TestMaintenanceRecoveryValidatesExactCapturedProfile(t *testing.T) {
	for _, kind := range []string{"valid", "replacement", "role", "storage", "database"} {
		t.Run(kind, func(t *testing.T) {
			config, _, cs := maintenanceFixture(t)
			receipt, _, err := readMaintenance(config)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "replacement":
				cs[2].ID = strings.Repeat("f", 64)
			case "role":
				cs[2].Config.Labels["com.docker.compose.service"] = "another"
			case "storage":
				cs[1].Config.Env[2] = "TEMPLATE_STORAGE_URL=file:///elsewhere"
			case "database":
				cs[0].NetworkSettings.Ports = nil
			}
			_, err = validateCapturedMaintenance(config, receipt, cs)
			if (err == nil) != (kind == "valid") {
				t.Fatalf("profile %s returned %v", kind, err)
			}
		})
	}
}
