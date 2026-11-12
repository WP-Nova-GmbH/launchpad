package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

func healthyNative() runtimeInventory {
	return runtimeInventory{Commit: stockRuntimeCommit, NodeID: "orchestrator", ServiceID: "process-1", Startup: time.Unix(1700000000, 0), Healthy: true, BuildIDs: []string{}}
}

type hostFixture struct {
	t            *testing.T
	calls        []string
	states       []runtimeInventory
	stops        [][]string
	starts       [][]string
	stopErrors   []error
	startError   error
	collectError error
	receiptError string
	scoped       context.Context
}

func (f *hostFixture) host() hostAccess {
	d := deployment{Writers: []string{"api", "dashboard", "proxy"}, Orchestrator: "orch", Database: "db"}
	record := func(name string) error {
		f.calls = append(f.calls, name)
		if f.receiptError == name {
			return errors.New("receipt write failed")
		}
		return nil
	}
	return hostAccess{
		inspect: func(context.Context) (deployment, error) { f.calls = append(f.calls, "inspect"); return d, nil },
		runtime: func(context.Context) (runtimeInventory, error) {
			f.calls = append(f.calls, "runtime")
			if len(f.states) == 0 {
				f.t.Fatal("unexpected runtime read")
			}
			state := f.states[0]
			f.states = f.states[1:]
			return state, nil
		},
		liveRoots: func(runtimeInventory) ([]Root, error) { f.calls = append(f.calls, "live-roots"); return []Root{}, nil },
		stop: func(ctx context.Context, ids []string) error {
			f.calls = append(f.calls, "stop")
			f.stops = append(f.stops, slices.Clone(ids))
			if len(f.stopErrors) != 0 {
				err := f.stopErrors[0]
				f.stopErrors = f.stopErrors[1:]
				return err
			}
			return ctx.Err()
		},
		start: func(ctx context.Context, ids []string) error {
			if ctx.Err() != nil {
				f.t.Fatal("restoration inherited cancelled work context")
			}
			f.calls = append(f.calls, "start")
			f.starts = append(f.starts, slices.Clone(ids))
			return f.startError
		},
		confirmStatic: func(ctx context.Context, _ deployment) error { f.calls = append(f.calls, "static"); return ctx.Err() },
		catalog: func(ctx context.Context, _ string, freeze bool, use catalogUse) error {
			f.calls = append(f.calls, "catalog")
			if f.scoped != nil {
				ctx = f.scoped
			}
			return use(ctx, catalogInventory{}, func(ctx context.Context) error { f.calls = append(f.calls, "locks"); return ctx.Err() })
		},
		beginMaintenance:  func(deployment) error { return record("receipt-begin") },
		recordStop:        func([]string) error { return record("receipt-stop") },
		recordRestoring:   func() error { return record("receipt-restoring") },
		finishMaintenance: func() error { return record("receipt-finished") },
	}
}

func (f *hostFixture) collect(ctx context.Context, _ catalogInventory, _ []Root, check func(context.Context) error) error {
	f.calls = append(f.calls, "collect")
	if err := check(ctx); err != nil {
		return err
	}
	return errors.Join(ctx.Err(), f.collectError)
}

func TestIdleHostSkipsBusyReportAndApplyWithoutStopping(t *testing.T) {
	for _, apply := range []bool{false, true} {
		for _, kind := range []string{"VMs", "work", "list"} {
			t.Run(kind+map[bool]string{true: "-apply", false: "-report"}[apply], func(t *testing.T) {
				state := healthyNative()
				switch kind {
				case "VMs":
					state.RunningVMs = 1
				case "work":
					state.OutstandingWork = 1
				case "list":
					state.BuildIDs = []string{cacheBuildA}
				}
				f := hostFixture{t: t, states: []runtimeInventory{state}}
				skipped, restored, err := withIdleHost(context.Background(), f.host(), apply, f.collect)
				if err != nil || skipped == "" || !restored || !reflect.DeepEqual(f.calls, []string{"inspect", "runtime"}) {
					t.Fatalf("unexpected busy result: %q %t %v %#v", skipped, restored, err, f.calls)
				}
			})
		}
	}
}

func TestIdleHostRestoresExactIDsAfterSuccessfulCollection(t *testing.T) {
	f := hostFixture{t: t, states: []runtimeInventory{healthyNative(), healthyNative()}}
	skipped, restored, err := withIdleHost(context.Background(), f.host(), true, f.collect)
	if err != nil || skipped != "" || !restored {
		t.Fatalf("unexpected result %q %t %v", skipped, restored, err)
	}
	if !reflect.DeepEqual(f.stops, [][]string{{"api", "dashboard", "proxy"}, {"orch"}}) || !reflect.DeepEqual(f.starts, [][]string{{"orch", "proxy", "dashboard", "api"}}) {
		t.Fatalf("wrong exact service lifecycle: stops=%v starts=%v", f.stops, f.starts)
	}
	for _, pair := range [][2]string{{"receipt-begin", "stop"}, {"receipt-restoring", "start"}, {"start", "receipt-finished"}} {
		if slices.Index(f.calls, pair[0]) >= slices.Index(f.calls, pair[1]) {
			t.Fatalf("receipt ordering wrong: %#v", f.calls)
		}
	}
}

func TestIdleHostNeverStopsOrchestratorAfterBusyOrChangedDrain(t *testing.T) {
	for _, kind := range []string{"VM", "list", "commit", "service", "startup", "status"} {
		t.Run(kind, func(t *testing.T) {
			after := healthyNative()
			switch kind {
			case "VM":
				after.RunningVMs = 1
			case "list":
				after.BuildIDs = []string{cacheBuildA}
			case "commit":
				after.Commit = "unknown"
			case "service":
				after.ServiceID = "replacement"
			case "startup":
				after.Startup = after.Startup.Add(time.Second)
			case "status":
				after.Healthy = false
			}
			f := hostFixture{t: t, states: []runtimeInventory{healthyNative(), after}}
			skipped, restored, err := withIdleHost(context.Background(), f.host(), true, f.collect)
			if !restored || len(f.stops) != 1 || len(f.starts) != 1 || slices.Contains(f.starts[0], "orch") || slices.Contains(f.calls, "collect") {
				t.Fatalf("touched busy/replaced orchestrator: %q %t %v %#v", skipped, restored, err, f.calls)
			}
			if kind == "VM" || kind == "list" {
				if err != nil || skipped == "" {
					t.Fatal("busy drain should skip")
				}
			} else if err == nil {
				t.Fatal("changed native identity accepted")
			}
		})
	}
}

func TestIdleHostUncertainStopsMustSettleBeforeRestart(t *testing.T) {
	for _, settles := range []bool{true, false} {
		t.Run(map[bool]string{true: "settled", false: "uncertain"}[settles], func(t *testing.T) {
			failures := []error{errors.New("stop interrupted"), nil}
			if !settles {
				failures[1] = errors.New("still stopping")
			}
			f := hostFixture{t: t, states: []runtimeInventory{healthyNative()}, stopErrors: failures}
			_, restored, err := withIdleHost(context.Background(), f.host(), true, f.collect)
			if err == nil || restored != settles || len(f.stops) != 2 || !reflect.DeepEqual(f.stops[0], f.stops[1]) {
				t.Fatalf("unexpected stop settlement: %t %v %#v", restored, err, f.calls)
			}
			if (len(f.starts) > 0) != settles || slices.Contains(f.calls, "collect") {
				t.Fatalf("unsafe uncertain-stop lifecycle: %#v", f.calls)
			}
		})
	}
}

func TestIdleHostFailureKeepsReceiptAndDoesNotClaimRestoration(t *testing.T) {
	for _, kind := range []string{"restore receipt", "health"} {
		t.Run(kind, func(t *testing.T) {
			f := hostFixture{t: t, states: []runtimeInventory{healthyNative(), healthyNative()}}
			if kind == "restore receipt" {
				f.receiptError = "receipt-restoring"
			} else {
				f.startError = errors.New("services not healthy")
			}
			_, restored, err := withIdleHost(context.Background(), f.host(), true, f.collect)
			if err == nil || restored || slices.Contains(f.calls, "receipt-finished") {
				t.Fatalf("claimed unconfirmed recovery: %t %v %#v", restored, err, f.calls)
			}
			if kind == "restore receipt" && len(f.starts) != 0 {
				t.Fatal("started without durable restoring receipt")
			}
		})
	}
}

func TestIdleHostUsesCatalogueScopedCancellation(t *testing.T) {
	scoped, cancel := context.WithCancel(context.Background())
	cancel()
	f := hostFixture{t: t, states: []runtimeInventory{healthyNative(), healthyNative()}, scoped: scoped}
	_, restored, err := withIdleHost(context.Background(), f.host(), true, f.collect)
	if err == nil || !restored || slices.Contains(f.calls, "collect") {
		t.Fatalf("lost catalogue allowed collection: %t %v %#v", restored, err, f.calls)
	}
}

func stockDockerFixture(t *testing.T) (cleanupConfig, []dockerContainer) {
	t.Helper()
	config := cleanupConfig{Project: "fixture", StoragePath: "/store/templates", BuildCachePath: "/store/build-cache", OrchestratorAddress: "127.0.0.1:5008"}
	result := []dockerContainer{}
	for i, role := range []string{"postgres", "orchestrator", "api", "dashboard-api", "client-proxy"} {
		var c dockerContainer
		data := `{"Id":"` + strings.Repeat(string(rune('a'+i)), 64) + `","Config":{"Labels":{"com.docker.compose.project":"fixture","com.docker.compose.service":"` + role + `"}},"State":{"Running":true,"Health":{"Status":"healthy"}},"HostConfig":{"NetworkMode":"host"}}`
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			t.Fatal(err)
		}
		switch role {
		case "postgres":
			c.Config.Env = []string{"POSTGRES_USER=postgres", "POSTGRES_DB=postgres", "POSTGRES_PASSWORD=fixture-password"}
			if err := json.Unmarshal([]byte(`{"Ports":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5432"}]}}`), &c.NetworkSettings); err != nil {
				t.Fatal(err)
			}
		case "orchestrator":
			c.HostConfig.PidMode = "host"
			c.HostConfig.CgroupnsMode = "host"
			c.HostConfig.Privileged = true
			c.Config.Cmd = []string{"/bin/bash", "/opt/e2b/scripts/orchestrator-launch.sh"}
			c.Config.Env = []string{"ORCHESTRATOR_SERVICES=orchestrator,template-manager", "GRPC_PORT=5008", "TEMPLATE_STORAGE_URL=file:///store/templates", "BUILD_CACHE_STORAGE_URL=file:///store/build-cache"}
		case "api", "dashboard-api":
			c.Config.Env = []string{"POSTGRES_CONNECTION_STRING=postgres://postgres:fixture-password@127.0.0.1:5432/postgres?sslmode=disable", "LOCAL_ORCHESTRATOR_ADDRESS=127.0.0.1:5008"}
		}
		result = append(result, c)
	}
	return config, result
}

func TestDeploymentRequiresExactStockOwnership(t *testing.T) {
	for _, kind := range []string{"valid", "namespace", "launcher", "patched", "database", "DB port", "storage", "extra writer", "extra project job", "replica", "unhealthy"} {
		t.Run(kind, func(t *testing.T) {
			config, cs := stockDockerFixture(t)
			all := slices.Clone(cs)
			switch kind {
			case "namespace":
				cs[1].HostConfig.PidMode = "private"
			case "launcher":
				cs[1].Config.Cmd = []string{"orchestrator"}
			case "patched":
				cs[1].Config.Env = append(cs[1].Config.Env, "OL_COMMAND=patched")
			case "database":
				cs[2].Config.Env = []string{"POSTGRES_CONNECTION_STRING=postgres://postgres:fixture-password@127.0.0.1:5432/wrong", "LOCAL_ORCHESTRATOR_ADDRESS=127.0.0.1:5008"}
			case "DB port":
				cs[0].NetworkSettings.Ports = nil
			case "storage":
				cs[1].Config.Env[2] = "TEMPLATE_STORAGE_URL=file:///wrong"
			case "extra writer":
				extra := cs[2]
				extra.ID = strings.Repeat("f", 64)
				extra.Config.Labels = map[string]string{"com.docker.compose.project": "other", "com.docker.compose.service": "api"}
				all = append(all, extra)
			case "extra project job":
				extra := cs[2]
				extra.ID = strings.Repeat("f", 64)
				extra.Config.Labels = map[string]string{"com.docker.compose.project": "fixture", "com.docker.compose.service": "base-template"}
				cs = append(cs, extra)
			case "replica":
				cs = append(cs, cs[2])
			case "unhealthy":
				cs[2].State.Health.Status = "starting"
			}
			got, err := validateDeployment(config, cs, all)
			if kind == "valid" {
				if err != nil || len(got.Writers) != 3 || got.Roles[got.Orchestrator] != "orchestrator" {
					t.Fatalf("valid stock profile rejected: %#v %v", got, err)
				}
			} else if err == nil {
				t.Fatalf("unsafe %s profile accepted", kind)
			}
		})
	}
}

// A fake docker executable models psql I/O; no Docker daemon or database is
// contacted. The FIFO lets the test end a live session without timing sleeps.
func fakeCatalogDocker(t *testing.T, mode string) string {
	t.Helper()
	base := t.TempDir()
	control := filepath.Join(base, "control")
	if err := syscall.Mkfifo(control, 0600); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
[ "$1" = exec ] || exit 40
inventory=0
while IFS= read -r line; do
  case "$line" in
    *"THEN 'launchpad-locks-held'"*)
      printf '%s\n' launchpad-locks-held
      if [ "$FAKE_CATALOG_MODE" = death ]; then IFS= read -r ignored < "$FAKE_CATALOG_CONTROL"; exit 0; fi ;;
    *"SELECT pg_current_xact_id()::text;"*)
      case "$line" in
        *"SET LOCAL idle_in_transaction_session_timeout='60s';"*) printf '%s\n' 123 ;;
        *) exit 44 ;;
      esac ;;
    ');') printf '%s\n' '{"schemaVersion":1,"roots":[],"unfinishedBuildIds":[],"issues":[]}' ;;
    '\echo launchpad-collection-transaction-closed') printf '%s\n' launchpad-collection-transaction-closed ;;
  esac
done
`
	if err := os.WriteFile(filepath.Join(base, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", base+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_CATALOG_MODE", mode)
	t.Setenv("FAKE_CATALOG_CONTROL", control)
	return control
}

func TestCatalogueChecksSameLiveTransaction(t *testing.T) {
	fakeCatalogDocker(t, "normal")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	called := false
	err := withDockerCatalog(ctx, "fixture", true, func(scoped context.Context, c catalogInventory, check func(context.Context) error) error {
		called = true
		if err := check(scoped); err != nil {
			return err
		}
		return check(scoped)
	})
	if err != nil || !called {
		t.Fatalf("live transaction failed: %v called=%t", err, called)
	}
}

func TestCatalogueDeathCancelsCollectionBeforeAnotherDeletion(t *testing.T) {
	control := fakeCatalogDocker(t, "death")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	called := false
	err := withDockerCatalog(ctx, "fixture", true, func(scoped context.Context, c catalogInventory, check func(context.Context) error) error {
		called = true
		if err := os.WriteFile(control, []byte("exit\n"), 0600); err != nil {
			return err
		}
		<-scoped.Done()
		return check(scoped)
	})
	if err == nil || !called {
		t.Fatalf("session death accepted: %v called=%t", err, called)
	}
}

func TestDockerRestorationAttemptsEveryCapturedIDAfterFailure(t *testing.T) {
	base := t.TempDir()
	config, containers := stockDockerFixture(t)
	_ = config
	ids := []string{containers[1].ID, containers[2].ID}
	data, err := json.Marshal([]dockerContainer{containers[1], containers[2]})
	if err != nil {
		t.Fatal(err)
	}
	inventory, log := filepath.Join(base, "inspect.json"), filepath.Join(base, "started.log")
	if err := os.WriteFile(inventory, data, 0600); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
case "$1" in
 events) exit 0 ;;
 start) printf '%s\n' "$2" >> "$FAKE_RESTORE_LOG"; [ "$2" = "$FAKE_FAIL_ID" ] && exit 1; exit 0 ;;
 inspect) cat "$FAKE_INSPECT" ;;
 *) exit 90 ;;
esac
`
	if err := os.WriteFile(filepath.Join(base, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", base+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_RESTORE_LOG", log)
	t.Setenv("FAKE_FAIL_ID", ids[0])
	t.Setenv("FAKE_INSPECT", inventory)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := restoreContainers(ctx, ids); err == nil {
		t.Fatal("reported success after failed restart")
	}
	started, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(strings.Fields(string(started)), ids) {
		t.Fatalf("did not attempt every captured restart: %s", started)
	}
}

func TestIdleHostDoesNotRestartBesideOrphanNativeExecution(t *testing.T) {
	f := hostFixture{t: t, states: []runtimeInventory{healthyNative(), healthyNative()}}
	host := f.host()
	host.confirmStatic = func(context.Context, deployment) error {
		f.calls = append(f.calls, "orphan-present")
		return errors.New("native execution remains")
	}
	_, restored, err := withIdleHost(context.Background(), host, true, f.collect)
	if err == nil || restored || len(f.starts) != 0 || slices.Contains(f.calls, "receipt-restoring") || slices.Contains(f.calls, "receipt-finished") {
		t.Fatalf("restarted beside orphan native execution: restored=%t err=%v calls=%v", restored, err, f.calls)
	}
	if strings.Count(strings.Join(f.calls, "|"), "orphan-present") < 2 {
		t.Fatal("restoration did not independently recheck native execution")
	}
}
