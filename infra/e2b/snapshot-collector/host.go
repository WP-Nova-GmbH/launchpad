package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type deployment struct {
	Writers      []string
	Orchestrator string
	Database     string
	Roles        map[string]string
}

type runtimeInventory struct {
	Commit          string
	NodeID          string
	ServiceID       string
	Startup         time.Time
	Healthy         bool
	RunningVMs      uint32
	OutstandingWork uint64
	BuildIDs        []string
}

type catalogUse func(context.Context, catalogInventory, func(context.Context) error) error

type hostAccess struct {
	inspect           func(context.Context) (deployment, error)
	runtime           func(context.Context) (runtimeInventory, error)
	liveRoots         func(runtimeInventory) ([]Root, error)
	stop              func(context.Context, []string) error
	start             func(context.Context, []string) error
	confirmStatic     func(context.Context, deployment) error
	catalog           func(context.Context, string, bool, catalogUse) error
	beginMaintenance  func(deployment) error
	recordStop        func([]string) error
	recordRestoring   func() error
	finishMaintenance func() error
}

func supportedRuntime(state runtimeInventory) bool {
	return len(state.Commit) >= 12 && strings.HasPrefix(stockRuntimeCommit, state.Commit) &&
		state.NodeID != "" && state.ServiceID != "" && !state.Startup.IsZero() && state.Healthy
}

func sameRuntime(before, after runtimeInventory) bool {
	return supportedRuntime(after) && before.Commit == after.Commit && before.NodeID == after.NodeID &&
		before.ServiceID == after.ServiceID && before.Startup.Equal(after.Startup)
}

func runtimeBusy(state runtimeInventory) bool {
	return state.RunningVMs != 0 || state.OutstandingWork != 0 || len(state.BuildIDs) != 0
}

// The collector never stops a VM to create a collection window. It closes only
// verified API admission, and checks the same native process again before stop.
func withIdleHost(ctx context.Context, host hostAccess, apply bool, collect func(context.Context, catalogInventory, []Root, func(context.Context) error) error) (skipped string, restored bool, err error) {
	d, err := host.inspect(ctx)
	if err != nil {
		return "", false, err
	}
	state, err := host.runtime(ctx)
	if err != nil {
		return "", false, err
	}
	if runtimeBusy(state) {
		return "host has running VMs or unfinished work", true, nil
	}
	if !apply {
		roots, err := host.liveRoots(state)
		if err != nil {
			return "", true, err
		}
		return "", true, host.catalog(ctx, d.Database, false, func(scoped context.Context, c catalogInventory, check func(context.Context) error) error {
			return collect(scoped, c, roots, check)
		})
	}
	if !supportedRuntime(state) {
		return "", true, errors.New("physical collection requires the supported healthy stock runtime identity")
	}
	original := state
	if err := host.beginMaintenance(d); err != nil {
		return "", true, err
	}
	stopped := []string{}
	uncertain := false
	defer func() {
		restoreCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		if len(stopped) == 0 {
			restored = true
			if finishErr := host.finishMaintenance(); finishErr != nil {
				err = errors.Join(err, finishErr)
			}
			return
		}
		// A cancelled Docker CLI can leave a daemon-side stop running. Settle
		// every attempted stop before starting anything; otherwise a late stop
		// could shut down a service after we reported successful restoration.
		if uncertain {
			if settleErr := host.stop(restoreCtx, stopped); settleErr != nil {
				restored = false
				err = errors.Join(err, errors.New("service shutdown remains uncertain; restart was withheld"), settleErr)
				return
			}
		}
		if slices.Contains(stopped, d.Orchestrator) {
			if staticErr := host.confirmStatic(restoreCtx, d); staticErr != nil {
				restored = false
				err = errors.Join(err, errors.New("native execution remains uncertain; orchestrator restart was withheld"), staticErr)
				return
			}
		}
		if receiptErr := host.recordRestoring(); receiptErr != nil {
			restored = false
			err = errors.Join(err, receiptErr)
			return
		}
		slices.Reverse(stopped)
		if restartErr := host.start(restoreCtx, stopped); restartErr != nil {
			restored = false
			err = errors.Join(err, restartErr)
		} else {
			restored = true
			if finishErr := host.finishMaintenance(); finishErr != nil {
				err = errors.Join(err, finishErr)
			}
		}
	}()
	if err := host.recordStop(d.Writers); err != nil {
		return "", true, err
	}
	stopped = append(stopped, d.Writers...)
	if err = host.stop(ctx, d.Writers); err != nil {
		uncertain = true
		return "", false, err
	}
	state, err = host.runtime(ctx)
	if err != nil {
		return "", false, err
	}
	if !sameRuntime(original, state) {
		return "", false, errors.New("native runtime changed while API admission drained")
	}
	if runtimeBusy(state) {
		return "host became busy while its API drained", false, nil
	}
	if err := host.recordStop(append(append([]string{}, stopped...), d.Orchestrator)); err != nil {
		return "", false, err
	}
	stopped = append(stopped, d.Orchestrator)
	if err = host.stop(ctx, []string{d.Orchestrator}); err != nil {
		uncertain = true
		return "", false, err
	}
	if err = host.confirmStatic(ctx, d); err != nil {
		return "", false, err
	}
	err = host.catalog(ctx, d.Database, true, func(scoped context.Context, c catalogInventory, check func(context.Context) error) error {
		if err := host.confirmStatic(scoped, d); err != nil {
			return err
		}
		if err := check(scoped); err != nil {
			return err
		}
		return collect(scoped, c, nil, check)
	})
	return "", false, err
}

type dockerContainer struct {
	ID     string `json:"Id"`
	Config struct {
		Labels     map[string]string `json:"Labels"`
		Env        []string          `json:"Env"`
		Entrypoint []string          `json:"Entrypoint"`
		Cmd        []string          `json:"Cmd"`
	} `json:"Config"`
	HostConfig struct {
		NetworkMode  string `json:"NetworkMode"`
		PidMode      string `json:"PidMode"`
		CgroupnsMode string `json:"CgroupnsMode"`
		Privileged   bool   `json:"Privileged"`
	} `json:"HostConfig"`
	State struct {
		Running   bool                     `json:"Running"`
		OOMKilled bool                     `json:"OOMKilled"`
		ExitCode  int                      `json:"ExitCode"`
		Health    *struct{ Status string } `json:"Health"`
	} `json:"State"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
	} `json:"NetworkSettings"`
}

func docker(ctx context.Context, args ...string) ([]byte, error) {
	output, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return nil, errors.New("Docker operation failed; no physical collection authorized")
	}
	return output, nil
}

func inspectContainers(ctx context.Context, ids []string) ([]dockerContainer, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	data, err := docker(ctx, append([]string{"inspect"}, ids...)...)
	if err != nil {
		return nil, err
	}
	var result []dockerContainer
	if json.Unmarshal(data, &result) != nil || len(result) != len(ids) {
		return nil, errors.New("invalid Docker inventory")
	}
	expected := map[string]bool{}
	for _, id := range ids {
		expected[id] = true
	}
	for _, c := range result {
		if !expected[c.ID] {
			return nil, errors.New("Docker container identity changed")
		}
		delete(expected, c.ID)
	}
	if len(expected) != 0 {
		return nil, errors.New("Docker container inventory is incomplete")
	}
	return result, nil
}

func containers(ctx context.Context, filters ...string) ([]dockerContainer, error) {
	args := []string{"ps", "-aq", "--no-trunc"}
	for _, filter := range filters {
		args = append(args, "--filter", filter)
	}
	ids, err := docker(ctx, args...)
	if err != nil {
		return nil, err
	}
	return inspectContainers(ctx, strings.Fields(string(ids)))
}

func environment(c dockerContainer, name string) string {
	for _, value := range c.Config.Env {
		if v, found := strings.CutPrefix(value, name+"="); found {
			return v
		}
	}
	return ""
}

func containerHealthy(c dockerContainer) bool {
	return c.State.Running && !c.State.OOMKilled && c.State.Health != nil && c.State.Health.Status == "healthy"
}

func stockNamespaceProfile(c dockerContainer, address string) bool {
	return c.HostConfig.NetworkMode == "host" && c.HostConfig.PidMode == "host" &&
		c.HostConfig.CgroupnsMode == "host" && c.HostConfig.Privileged &&
		len(c.Config.Entrypoint) == 0 && slices.Equal(c.Config.Cmd, []string{"/bin/bash", "/opt/e2b/scripts/orchestrator-launch.sh"}) &&
		strings.TrimSpace(environment(c, "OL_COMMAND")) == "" &&
		(environment(c, "OL_CGROUP_ROOT") == "" || environment(c, "OL_CGROUP_ROOT") == "/sys/fs/cgroup/e2b") &&
		environment(c, "ORCHESTRATOR_SERVICES") == "orchestrator,template-manager" &&
		address == "127.0.0.1:"+environment(c, "GRPC_PORT")
}

func postgresDefaults(c dockerContainer) (string, string) {
	user := environment(c, "POSTGRES_USER")
	if user == "" {
		user = "postgres"
	}
	database := environment(c, "POSTGRES_DB")
	if database == "" {
		database = user
	}
	return user, database
}

func databaseEndpoint(raw string) (host, port, database string, ok bool) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.User == nil {
		return "", "", "", false
	}
	port = u.Port()
	if port == "" {
		port = "5432"
	}
	return u.Hostname(), port, strings.TrimPrefix(u.Path, "/"), true
}

func ownsDatabase(api, postgres dockerContainer) bool {
	raw := environment(api, "POSTGRES_CONNECTION_STRING")
	host, port, database, ok := databaseEndpoint(raw)
	if !ok || host != "127.0.0.1" {
		return false
	}
	user, db := postgresDefaults(postgres)
	u, _ := url.Parse(raw)
	password, hasPassword := u.User.Password()
	if database != db || u.User.Username() != user || !hasPassword || password != environment(postgres, "POSTGRES_PASSWORD") || u.Fragment != "" {
		return false
	}
	if u.RawQuery != "" && u.RawQuery != "sslmode=disable" {
		return false
	}
	for _, binding := range postgres.NetworkSettings.Ports["5432/tcp"] {
		if binding.HostIP == host && binding.HostPort == port {
			return true
		}
	}
	return false
}

func fileStorageMatches(c dockerContainer, name, expected string) bool {
	u, err := url.Parse(environment(c, name))
	return err == nil && u.Scheme == "file" && u.Host == "" && u.Path == expected && u.RawQuery == "" && u.Fragment == ""
}

func validateDeployment(config cleanupConfig, project, all []dockerContainer) (deployment, error) {
	d := deployment{Roles: map[string]string{}}
	seen := map[string]dockerContainer{}
	owned := map[string]bool{}
	for _, c := range project {
		service := c.Config.Labels["com.docker.compose.service"]
		if c.Config.Labels["com.docker.compose.project"] != config.Project || c.ID == "" {
			return d, errors.New("Docker project identity changed")
		}
		owned[c.ID] = true
		if c.State.Running && !slices.Contains([]string{"api", "dashboard-api", "client-proxy", "orchestrator", "postgres", "redis", "clickhouse", "vector", "otel-collector", "dashboard", "ready"}, service) {
			return d, errors.New("an unsupported project service is running during collection")
		}
		switch service {
		case "api", "dashboard-api", "client-proxy", "orchestrator", "postgres":
			if _, ok := seen[service]; ok {
				return d, errors.New("replicated E2B deployments are not supported")
			}
			seen[service] = c
			d.Roles[c.ID] = service
		}
	}
	postgres, ok := seen["postgres"]
	if !ok || !containerHealthy(postgres) {
		return d, errors.New("owning PostgreSQL is not healthy")
	}
	d.Database = postgres.ID
	orch, ok := seen["orchestrator"]
	if !ok || !containerHealthy(orch) || !stockNamespaceProfile(orch, config.OrchestratorAddress) ||
		!fileStorageMatches(orch, "TEMPLATE_STORAGE_URL", config.StoragePath) || !fileStorageMatches(orch, "BUILD_CACHE_STORAGE_URL", config.BuildCachePath) {
		return d, errors.New("collector requires the verified stock host-namespace orchestrator profile and matching storage")
	}
	d.Orchestrator = orch.ID
	for _, service := range []string{"api", "dashboard-api", "client-proxy"} {
		c, ok := seen[service]
		if !ok {
			return d, errors.New("E2B writer-role inventory is incomplete")
		}
		if c.HostConfig.NetworkMode != "host" {
			return d, errors.New("E2B writers must use the supported host network")
		}
		if service != "client-proxy" && !ownsDatabase(c, postgres) {
			return d, errors.New("E2B writer catalogue does not match owning PostgreSQL")
		}
		if service == "api" && environment(c, "LOCAL_ORCHESTRATOR_ADDRESS") != config.OrchestratorAddress {
			return d, errors.New("E2B API does not own the configured orchestrator")
		}
		if c.State.Running {
			if !containerHealthy(c) {
				return d, errors.New("E2B writer is not healthy")
			}
			d.Writers = append(d.Writers, c.ID)
		} else if service == "api" {
			return d, errors.New("E2B API must be running before idle-host collection")
		}
	}
	for _, c := range all {
		if !c.State.Running || owned[c.ID] {
			continue
		}
		service := c.Config.Labels["com.docker.compose.service"]
		host, port, db, sameDB := databaseEndpoint(environment(c, "POSTGRES_CONNECTION_STRING"))
		_, nativeDB := postgresDefaults(postgres)
		sharedCatalog := sameDB && host == "127.0.0.1" && db == nativeDB
		if sharedCatalog {
			sharedCatalog = false
			for _, binding := range postgres.NetworkSettings.Ports["5432/tcp"] {
				sharedCatalog = sharedCatalog || binding.HostIP == host && binding.HostPort == port
			}
		}
		if slices.Contains([]string{"api", "dashboard-api", "client-proxy", "orchestrator", "template-manager"}, service) ||
			environment(c, "LOCAL_ORCHESTRATOR_ADDRESS") == config.OrchestratorAddress || sharedCatalog ||
			fileStorageMatches(c, "TEMPLATE_STORAGE_URL", config.StoragePath) || fileStorageMatches(c, "BUILD_CACHE_STORAGE_URL", config.BuildCachePath) {
			return d, errors.New("another container can write the E2B catalogue or storage")
		}
	}
	return d, nil
}

func inspectDeployment(ctx context.Context, config cleanupConfig) (deployment, error) {
	project, err := containers(ctx, "label=com.docker.compose.project="+config.Project)
	if err != nil {
		return deployment{}, err
	}
	all, err := containers(ctx, "status=running")
	if err != nil {
		return deployment{}, err
	}
	return validateDeployment(config, project, all)
}

func newDockerHost(config cleanupConfig) hostAccess {
	return hostAccess{
		inspect: func(ctx context.Context) (deployment, error) { return inspectDeployment(ctx, config) },
		runtime: func(ctx context.Context) (runtimeInventory, error) {
			return inspectRuntime(ctx, config.OrchestratorAddress)
		},
		liveRoots: func(inventory runtimeInventory) ([]Root, error) {
			roots := []Root{}
			for _, id := range inventory.BuildIDs {
				root, err := readMetadataRoot(config.StoragePath, id)
				if err != nil {
					return nil, err
				}
				roots = append(roots, root)
			}
			return roots, nil
		},
		stop:  stopContainers,
		start: restoreContainers,
		confirmStatic: func(ctx context.Context, d deployment) error {
			ids := append(append([]string{}, d.Writers...), d.Orchestrator)
			cs, err := inspectContainers(ctx, ids)
			if err != nil {
				return err
			}
			for _, c := range cs {
				if c.State.Running || c.State.OOMKilled || c.State.ExitCode == 137 {
					return errors.New("E2B writers did not stop gracefully")
				}
			}
			current, err := containers(ctx, "status=running")
			if err != nil {
				return err
			}
			for _, c := range current {
				if c.Config.Labels["com.docker.compose.project"] == config.Project && slices.Contains([]string{"api", "dashboard-api", "client-proxy", "orchestrator"}, c.Config.Labels["com.docker.compose.service"]) {
					return errors.New("a new E2B writer appeared during collection")
				}
			}
			return verifyNoNativeProcesses()
		},
		catalog:           withDockerCatalog,
		beginMaintenance:  func(d deployment) error { return beginMaintenance(config, d) },
		recordStop:        func(ids []string) error { return recordMaintenanceStop(config, ids) },
		recordRestoring:   func() error { return markMaintenanceRestoring(config) },
		finishMaintenance: func() error { return finishMaintenance(config) },
	}
}

func stopContainers(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if _, err := docker(ctx, append([]string{"stop", "--time=-1"}, ids...)...); err != nil {
		return err
	}
	cs, err := inspectContainers(ctx, ids)
	if err != nil {
		return err
	}
	for _, c := range cs {
		if c.State.Running {
			return errors.New("Docker stop has not completed")
		}
	}
	return nil
}

// Restore all captured IDs even if one fails. A Docker event stream is opened
// first so healthy/die events cannot be missed between start and inspection.
func restoreContainers(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	eventCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	args := []string{"events", "--since", strconv.FormatInt(time.Now().Unix(), 10), "--filter", "type=container", "--format", "{{json .}}"}
	for _, id := range ids {
		args = append(args, "--filter", "container="+id)
	}
	command := exec.CommandContext(eventCtx, "docker", args...)
	events := make(chan struct{}, 1)
	ended := make(chan struct{})
	output, monitorErr := command.StdoutPipe()
	if monitorErr == nil {
		monitorErr = command.Start()
	}
	if monitorErr != nil {
		close(ended)
	} else {
		go func() {
			defer close(ended)
			scanner := bufio.NewScanner(output)
			for scanner.Scan() {
				select {
				case events <- struct{}{}:
				default:
				}
			}
		}()
		defer func() { cancel(); <-ended; command.Wait() }()
	}
	var failures []error
	// Even a failed event monitor must not prevent attempts to restore every
	// captured service. A later inspect can still confirm immediate recovery.
	for _, id := range ids {
		if _, err := docker(ctx, "start", id); err != nil {
			failures = append(failures, errors.New("an original E2B service could not be restarted"))
		}
	}
	for {
		cs, err := inspectContainers(ctx, ids)
		if err != nil {
			return errors.Join(append(failures, err)...)
		}
		healthy := true
		for _, c := range cs {
			healthy = healthy && containerHealthy(c)
		}
		if healthy {
			return errors.Join(failures...)
		}
		if monitorErr != nil {
			return errors.Join(append(failures, errors.New("cannot monitor restored E2B service health"))...)
		}
		select {
		case <-ctx.Done():
			return errors.Join(append(failures, errors.New("original E2B services did not recover healthy before the restore deadline"))...)
		case <-ended:
			return errors.Join(append(failures, errors.New("E2B service health event stream ended before restoration was confirmed"))...)
		case <-events:
		}
	}
}

const catalogLockTables = "public.envs,public.env_builds,public.env_build_assignments,public.active_template_builds,public.snapshots,public.snapshot_templates"

// The same transaction owns every SHARE lock throughout use. Session death
// cancels use immediately; checkLocked provides an additional synchronous check
// immediately before each physical deletion. The finite server idle lease also
// releases locks after an uncatchable collector crash; expiry cancels collection
// and never permits a new transaction to resume the old sweep.
func withDockerCatalog(ctx context.Context, database string, freeze bool, use catalogUse) (resultErr error) {
	scoped, cancel := context.WithCancelCause(ctx)
	command := exec.CommandContext(scoped, "docker", "exec", "-i", database, "sh", "-c", `exec psql -X -qAt --no-password -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"`)
	input, err := command.StdinPipe()
	if err != nil {
		cancel(err)
		return errors.New("cannot open catalogue transaction")
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		cancel(err)
		return errors.New("cannot read catalogue transaction")
	}
	if err = command.Start(); err != nil {
		input.Close()
		cancel(err)
		return errors.New("cannot start catalogue transaction")
	}
	lines := make(chan string, 1)
	readerDone := make(chan struct{})
	var closing atomic.Bool
	go func() {
		defer close(readerDone)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 32<<20)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-scoped.Done():
				return
			}
		}
		if !closing.Load() {
			cancel(errors.New("native catalogue transaction was lost"))
		}
	}()
	defer func() {
		input.Close()
		if !closing.Load() {
			cancel(errors.New("catalogue session closed before confirmation"))
		}
		select {
		case <-readerDone:
		case <-time.After(5 * time.Second):
			cancel(errors.New("catalogue session did not close"))
			<-readerDone
		}
		if err := command.Wait(); err != nil && resultErr == nil {
			resultErr = errors.New("native catalogue transaction did not exit successfully")
		}
		cancel(nil)
	}()
	readLine := func(callCtx context.Context) (string, error) {
		deadline, cancelRead := context.WithTimeout(callCtx, 30*time.Second)
		defer cancelRead()
		select {
		case line := <-lines:
			return line, nil
		case <-scoped.Done():
			return "", errors.New("native catalogue transaction was lost")
		case <-deadline.Done():
			cancel(errors.New("catalogue response deadline exceeded"))
			return "", errors.New("native catalogue response timed out")
		}
	}
	submit := func(sql string) error {
		if scoped.Err() != nil {
			return errors.New("native catalogue transaction was lost")
		}
		if _, err := io.WriteString(input, sql+"\n"); err != nil {
			cancel(err)
			return errors.New("cannot submit catalogue request")
		}
		return nil
	}
	begin := "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;"
	transaction := ""
	if freeze {
		begin = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='60s'; LOCK TABLE " + catalogLockTables + " IN SHARE MODE; SELECT pg_current_xact_id()::text;"
	}
	if err = submit(begin); err != nil {
		return err
	}
	if freeze {
		transaction, err = readLine(scoped)
		if err != nil {
			return err
		}
		if _, err = strconv.ParseUint(transaction, 10, 64); err != nil {
			return errors.New("native catalogue transaction identity is invalid")
		}
	}
	if err = submit(catalogInventorySQL); err != nil {
		return err
	}
	line, err := readLine(scoped)
	if err != nil {
		return err
	}
	inventory, err := parseCatalogInventory([]byte(line))
	if err != nil {
		return err
	}
	var mu sync.Mutex
	checkLocked := func(callCtx context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		if err := callCtx.Err(); err != nil {
			return err
		}
		if scoped.Err() != nil {
			return errors.New("native catalogue transaction was lost")
		}
		if !freeze {
			return nil
		}
		sql := "SELECT CASE WHEN pg_current_xact_id()::text='" + transaction + "' AND (SELECT count(DISTINCT relation) FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareLock' AND granted AND relation IN ('public.envs'::regclass,'public.env_builds'::regclass,'public.env_build_assignments'::regclass,'public.active_template_builds'::regclass,'public.snapshots'::regclass,'public.snapshot_templates'::regclass))=6 THEN 'launchpad-locks-held' ELSE 'launchpad-locks-lost' END;"
		if err := submit(sql); err != nil {
			return err
		}
		answer, err := readLine(callCtx)
		if err != nil {
			return err
		}
		if answer != "launchpad-locks-held" || scoped.Err() != nil {
			cancel(errors.New("native catalogue locks were lost"))
			return errors.New("native catalogue locks were lost")
		}
		return nil
	}
	if err = checkLocked(scoped); err != nil {
		return err
	}
	if err = use(scoped, inventory, checkLocked); err != nil {
		return err
	}
	if err = checkLocked(scoped); err != nil {
		return err
	}
	if err = submit("ROLLBACK;\n\\echo launchpad-collection-transaction-closed"); err != nil {
		return err
	}
	answer, err := readLine(scoped)
	if err != nil {
		return err
	}
	if answer != "launchpad-collection-transaction-closed" {
		return errors.New("catalogue transaction completion was not confirmed")
	}
	closing.Store(true)
	return nil
}

func verifyNoNativeProcesses() error {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return errors.New("cannot inspect Linux processes")
	}
	for _, entry := range entries {
		if entry.Name() == "" || entry.Name()[0] < '0' || entry.Name()[0] > '9' {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "comm"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return errors.New("native process inventory is unavailable")
		}
		if slices.Contains([]string{"firecracker", "orchestrator", "template-manager", "template-manage"}, strings.TrimSpace(string(data))) {
			return errors.New("native E2B execution is still present")
		}
	}
	return filepath.WalkDir("/sys/fs/cgroup/e2b", func(path string, entry os.DirEntry, err error) error {
		if os.IsNotExist(err) && path == "/sys/fs/cgroup/e2b" {
			return nil
		}
		if err != nil {
			return errors.New("cannot inspect E2B cgroups")
		}
		if entry.Name() != "cgroup.events" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return errors.New("cannot read E2B cgroup state")
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == "populated 1" {
				return errors.New("E2B workload is still present")
			}
		}
		return nil
	})
}
