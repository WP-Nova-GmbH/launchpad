package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
)

type maintenanceIdentity struct {
	Project             string `json:"project"`
	StoragePath         string `json:"storagePath"`
	BuildCachePath      string `json:"buildCachePath"`
	OrchestratorAddress string `json:"orchestratorAddress"`
}

type maintenanceReceipt struct {
	SchemaVersion    int                 `json:"schemaVersion"`
	Identity         maintenanceIdentity `json:"identity"`
	Phase            string              `json:"phase"`
	Deployment       deployment          `json:"deployment"`
	AttemptedStopIDs []string            `json:"attemptedStopIds"`
}

func maintenanceProfile(config cleanupConfig) maintenanceIdentity {
	return maintenanceIdentity{config.Project, config.StoragePath, config.BuildCachePath, config.OrchestratorAddress}
}
func maintenancePath(config cleanupConfig) string { return config.JournalPath + ".maintenance.json" }

func validContainerID(id string) bool {
	if len(id) != 64 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func validateMaintenance(config cleanupConfig, receipt maintenanceReceipt) error {
	if receipt.SchemaVersion != 1 || receipt.Identity != maintenanceProfile(config) || !slices.Contains([]string{"pending", "restoring", "restored"}, receipt.Phase) || receipt.AttemptedStopIDs == nil {
		return errors.New("maintenance receipt profile or phase is invalid")
	}
	d := receipt.Deployment
	ids := append(append([]string{}, d.Writers...), d.Orchestrator, d.Database)
	seen := map[string]bool{}
	for _, id := range ids {
		if !validContainerID(id) || seen[id] {
			return errors.New("maintenance receipt container identities are invalid")
		}
		seen[id] = true
	}
	if len(d.Writers) == 0 || len(d.Roles) != len(ids) || d.Roles[d.Orchestrator] != "orchestrator" || d.Roles[d.Database] != "postgres" {
		return errors.New("maintenance receipt roles are incomplete")
	}
	api := false
	roleSeen := map[string]bool{}
	for _, id := range d.Writers {
		role := d.Roles[id]
		if !slices.Contains([]string{"api", "dashboard-api", "client-proxy"}, role) || roleSeen[role] {
			return errors.New("maintenance writer roles are invalid")
		}
		roleSeen[role] = true
		api = api || role == "api"
	}
	if !api {
		return errors.New("maintenance API identity is missing")
	}
	attempted := map[string]bool{}
	for _, id := range receipt.AttemptedStopIDs {
		if attempted[id] || (!slices.Contains(d.Writers, id) && id != d.Orchestrator) {
			return errors.New("maintenance stop identities are invalid")
		}
		attempted[id] = true
	}
	if attempted[d.Orchestrator] {
		for _, id := range d.Writers {
			if !attempted[id] {
				return errors.New("orchestrator stop intent requires every API writer intent")
			}
		}
	}
	return nil
}

func readMaintenance(config cleanupConfig) (maintenanceReceipt, bool, error) {
	path := maintenancePath(config)
	root, err := openCacheDirectory(filepath.Dir(path))
	if err != nil {
		return maintenanceReceipt{}, false, err
	}
	defer root.Close()
	name := filepath.Base(path)
	info, err := root.Lstat(name)
	if os.IsNotExist(err) {
		return maintenanceReceipt{}, false, nil
	}
	if err != nil {
		return maintenanceReceipt{}, false, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return maintenanceReceipt{}, false, errors.New("maintenance receipt must be a private regular file")
	}
	data, err := cacheReadRegular(root, name, 64<<10)
	if err != nil {
		return maintenanceReceipt{}, false, err
	}
	var receipt maintenanceReceipt
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return receipt, false, errors.New("maintenance receipt is invalid")
	}
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return receipt, false, errors.New("maintenance receipt contains trailing data")
	}
	if err := validateMaintenance(config, receipt); err != nil {
		return receipt, false, err
	}
	return receipt, true, nil
}

// Atomic replacement and directory fsync make stop intent survive SIGKILL or
// power loss. The caller holds the host maintenance flock throughout.
func writeMaintenance(config cleanupConfig, receipt maintenanceReceipt) error {
	if err := validateMaintenance(config, receipt); err != nil {
		return err
	}
	path := maintenancePath(config)
	root, err := openCacheDirectory(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer root.Close()
	name := filepath.Base(path)
	if info, err := root.Lstat(name); err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return errors.New("maintenance receipt target is not a private regular file")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	temporary := "." + name + ".tmp-" + hex.EncodeToString(random)
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	if err := json.NewEncoder(file).Encode(receipt); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := root.Rename(temporary, name); err != nil {
		return err
	}
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}

func beginMaintenance(config cleanupConfig, d deployment) error {
	previous, exists, err := readMaintenance(config)
	if err != nil {
		return err
	}
	if exists && previous.Phase != "restored" {
		return errors.New("unfinished host maintenance must be recovered before collection")
	}
	captured := deployment{Writers: append([]string{}, d.Writers...), Orchestrator: d.Orchestrator, Database: d.Database, Roles: map[string]string{}}
	for _, id := range append(append([]string{}, d.Writers...), d.Orchestrator, d.Database) {
		captured.Roles[id] = d.Roles[id]
	}
	return writeMaintenance(config, maintenanceReceipt{1, maintenanceProfile(config), "pending", captured, []string{}})
}

func updateMaintenance(config cleanupConfig, update func(*maintenanceReceipt) error) error {
	receipt, exists, err := readMaintenance(config)
	if err != nil {
		return err
	}
	if !exists {
		return errors.New("maintenance receipt is missing")
	}
	if err := update(&receipt); err != nil {
		return err
	}
	return writeMaintenance(config, receipt)
}

func recordMaintenanceStop(config cleanupConfig, ids []string) error {
	return updateMaintenance(config, func(r *maintenanceReceipt) error {
		if r.Phase != "pending" {
			return errors.New("cannot stop services after restoration began")
		}
		for _, old := range r.AttemptedStopIDs {
			if !slices.Contains(ids, old) {
				return errors.New("maintenance stop intent cannot be removed")
			}
		}
		r.AttemptedStopIDs = append([]string{}, ids...)
		return nil
	})
}

func markMaintenanceRestoring(config cleanupConfig) error {
	return updateMaintenance(config, func(r *maintenanceReceipt) error {
		if r.Phase == "restored" {
			return errors.New("maintenance already finished")
		}
		r.Phase = "restoring"
		return nil
	})
}

func finishMaintenance(config cleanupConfig) error {
	return updateMaintenance(config, func(r *maintenanceReceipt) error { r.Phase = "restored"; return nil })
}

// Recovery addresses only IDs recorded before stop; it never discovers a
// replacement container or stops a service after restoration already began.
func recoverMaintenance(ctx context.Context, config cleanupConfig) (bool, error) {
	receipt, exists, err := readMaintenance(config)
	if err != nil {
		return false, err
	}
	if !exists || receipt.Phase == "restored" {
		return false, nil
	}
	ids := append(append([]string{}, receipt.Deployment.Writers...), receipt.Deployment.Orchestrator, receipt.Deployment.Database)
	captured, err := inspectContainers(ctx, ids)
	if err != nil {
		return true, err
	}
	running, err := validateCapturedMaintenance(config, receipt, captured)
	if err != nil {
		return true, err
	}
	host := newDockerHost(config)
	// Recovery itself does not collect. A previously crashed container may have
	// a non-graceful exit status, but no orphan native execution may be doubled.
	host.confirmStatic = func(context.Context, deployment) error { return verifyNoNativeProcesses() }
	return true, recoverRecordedMaintenance(ctx, config, receipt, host, running)
}

func validateCapturedMaintenance(config cleanupConfig, receipt maintenanceReceipt, captured []dockerContainer) (bool, error) {
	if err := validateMaintenance(config, receipt); err != nil {
		return false, err
	}
	d := receipt.Deployment
	byID := map[string]dockerContainer{}
	for _, c := range captured {
		role, ok := d.Roles[c.ID]
		if !ok || c.Config.Labels["com.docker.compose.project"] != config.Project || c.Config.Labels["com.docker.compose.service"] != role {
			return false, errors.New("recorded maintenance container identity changed")
		}
		if _, exists := byID[c.ID]; exists {
			return false, errors.New("duplicate recorded maintenance container")
		}
		byID[c.ID] = c
	}
	if len(byID) != len(d.Roles) {
		return false, errors.New("recorded maintenance container is missing")
	}
	postgres := byID[d.Database]
	if !containerHealthy(postgres) {
		return false, errors.New("recorded PostgreSQL is not yet healthy")
	}
	orch := byID[d.Orchestrator]
	if !stockNamespaceProfile(orch, config.OrchestratorAddress) || !fileStorageMatches(orch, "TEMPLATE_STORAGE_URL", config.StoragePath) || !fileStorageMatches(orch, "BUILD_CACHE_STORAGE_URL", config.BuildCachePath) {
		return false, errors.New("recorded orchestrator profile or storage changed")
	}
	for _, id := range d.Writers {
		c := byID[id]
		role := d.Roles[id]
		if c.HostConfig.NetworkMode != "host" || (role != "client-proxy" && !ownsDatabase(c, postgres)) || (role == "api" && environment(c, "LOCAL_ORCHESTRATOR_ADDRESS") != config.OrchestratorAddress) {
			return false, errors.New("recorded writer profile or catalogue changed")
		}
	}
	return orch.State.Running, nil
}

func recoverRecordedMaintenance(ctx context.Context, config cleanupConfig, receipt maintenanceReceipt, host hostAccess, orchestratorRunning bool) error {
	if receipt.Phase == "pending" {
		if slices.Contains(receipt.AttemptedStopIDs, receipt.Deployment.Orchestrator) && orchestratorRunning {
			state, err := host.runtime(ctx)
			if err != nil {
				return err
			}
			if !supportedRuntime(state) || runtimeBusy(state) {
				return errors.New("maintenance recovery will not stop a busy or unknown native runtime")
			}
		}
		if len(receipt.AttemptedStopIDs) != 0 {
			if err := host.stop(ctx, receipt.AttemptedStopIDs); err != nil {
				return err
			}
			if slices.Contains(receipt.AttemptedStopIDs, receipt.Deployment.Orchestrator) {
				if err := host.confirmStatic(ctx, receipt.Deployment); err != nil {
					return err
				}
			}
		}
		if err := markMaintenanceRestoring(config); err != nil {
			return err
		}
	}
	ids := append([]string{}, receipt.AttemptedStopIDs...)
	slices.Reverse(ids)
	if err := host.start(ctx, ids); err != nil {
		return err
	}
	return finishMaintenance(config)
}
