// Launchpad's collector is a separate host tool; it does not alter E2B binaries.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

const stockRuntimeCommit = "518278060a154124a80d98f37253f8af77baf478"

// Maintenance must serialize even when two invocations use different configs or
// journal files. This path belongs to the Linux host, not a Compose deployment.
const hostCollectorLockPath = "/run/lock/launchpad-e2b-snapshot-collector.lock"

// Startup and artifact staging must find an interrupted maintenance window
// before touching the native services, even if a collector config is replaced.
const hostCollectorJournalPath = "/var/lib/e2b/snapshot-collection.jsonl"

type cleanupConfig struct {
	SchemaVersion       int    `json:"schemaVersion"`
	Project             string `json:"project"`
	StoragePath         string `json:"storagePath"`
	BuildCachePath      string `json:"buildCachePath"`
	JournalPath         string `json:"journalPath"`
	OrchestratorAddress string `json:"orchestratorAddress"`
	MinimumAgeSeconds   int64  `json:"minimumAgeSeconds"`
}

func decodeConfig(reader io.Reader) (cleanupConfig, error) {
	var config cleanupConfig
	data, err := io.ReadAll(io.LimitReader(reader, (64<<10)+1))
	if err != nil || len(data) > 64<<10 {
		return config, errors.New("collector configuration exceeds 64 KiB or is unreadable")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, errors.New("invalid collector configuration")
	}
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return config, errors.New("collector configuration must contain one JSON object")
	}
	if config.SchemaVersion != 1 || !regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`).MatchString(config.Project) {
		return config, errors.New("schemaVersion 1 and an explicit Compose project are required")
	}
	if config.JournalPath != hostCollectorJournalPath {
		return config, errors.New("journalPath must use the canonical host snapshot journal /var/lib/e2b/snapshot-collection.jsonl")
	}
	for _, path := range []string{config.StoragePath, config.BuildCachePath, config.JournalPath} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" || strings.ContainsAny(path, "\x00\r\n") {
			return config, errors.New("storage, build-cache and journal paths must be canonical absolute paths")
		}
	}
	if config.StoragePath == config.BuildCachePath || within(config.StoragePath, config.BuildCachePath) || within(config.BuildCachePath, config.StoragePath) || within(config.StoragePath, config.JournalPath) || within(config.BuildCachePath, config.JournalPath) || within(config.JournalPath, config.StoragePath) || within(config.JournalPath, config.BuildCachePath) {
		return config, errors.New("storage, build-cache and journal paths must be separate")
	}
	if config.MinimumAgeSeconds < 60 || config.MinimumAgeSeconds > 365*24*60*60 {
		return config, errors.New("minimumAgeSeconds must be between one minute and one year")
	}
	if config.OrchestratorAddress != "127.0.0.1:5008" {
		return config, errors.New("only the dedicated host's loopback E2B orchestrator is supported")
	}
	return config, nil
}

func within(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

type cleanupReport struct {
	DryRun           bool     `json:"dryRun"`
	Skipped          string   `json:"skipped,omitempty"`
	RetainedLayers   int      `json:"retainedLayers"`
	CandidateIDs     []string `json:"candidateIds"`
	CandidateBytes   int64    `json:"candidateAllocatedBytes"`
	DeletedIDs       []string `json:"deletedIds"`
	UnknownPaths     []string `json:"unknownPaths"`
	ServicesRestored bool     `json:"servicesRestored"`
}

func planCollection(ctx context.Context, config cleanupConfig, catalog catalogInventory, live []Root, now time.Time) (cleanupReport, []storedLayer, map[string]struct{}, error) {
	report := cleanupReport{DryRun: true, CandidateIDs: []string{}, DeletedIDs: []string{}, UnknownPaths: []string{}}
	if len(catalog.Issues) != 0 || len(catalog.UnfinishedBuildIDs) != 0 {
		return report, nil, nil, errors.New("native catalogue contains unfinished or inconsistent records; no collection authorized")
	}
	roots := append([]Root{}, live...)
	for _, root := range catalog.Roots {
		roots = append(roots, Root{BuildID: root.BuildID, FilesystemOnly: root.FilesystemOnly})
	}
	cached, err := buildCacheRoots(config.BuildCachePath, config.StoragePath)
	if err != nil {
		return report, nil, nil, err
	}
	roots = append(roots, cached...)
	retained, err := Mark(ctx, roots, func(ctx context.Context, root Root) ([]LayerRef, error) {
		return readStoredReferences(ctx, config.StoragePath, root)
	})
	if err != nil {
		return report, nil, nil, err
	}
	inventory, err := scanStorage(config.StoragePath)
	if err != nil {
		return report, nil, nil, err
	}
	report.RetainedLayers = len(retained)
	report.UnknownPaths = inventory.Unknown
	cutoff := now.Add(-time.Duration(config.MinimumAgeSeconds) * time.Second)
	candidates := []storedLayer{}
	for _, layer := range inventory.Layers {
		if _, keep := retained[layer.BuildID]; keep || !layer.LatestWrite.Before(cutoff) {
			continue
		}
		candidates = append(candidates, layer)
		report.CandidateIDs = append(report.CandidateIDs, layer.BuildID)
		report.CandidateBytes += layer.AllocatedBytes
	}
	sort.Strings(report.CandidateIDs)
	return report, candidates, retained, nil
}

func openJournal(path string) (*os.File, error) {
	if resolved, err := filepath.EvalSymlinks(filepath.Dir(path)); err != nil || resolved != filepath.Dir(path) {
		return nil, errors.New("journal parent must exist and must not contain symlinks")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, errors.New("cannot open collector journal")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		file.Close()
		return nil, errors.New("collector journal must be a private regular file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || stat.Uid != uint32(os.Geteuid()) {
		file.Close()
		return nil, errors.New("collector journal ownership is invalid")
	}
	parent, err := os.Open(filepath.Dir(path))
	if err != nil {
		file.Close()
		return nil, errors.New("cannot open collector journal directory")
	}
	err = errors.Join(file.Sync(), parent.Sync(), parent.Close())
	if err != nil {
		file.Close()
		return nil, errors.New("cannot persist collector journal directory")
	}
	return file, nil
}

func acquireCollectorLock(path string) (*os.File, error) {
	file, err := openJournal(path)
	if err != nil {
		return nil, errors.New("cannot open the host collector lock")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, errors.New("another collector holds this host's maintenance lock")
	}
	return file, nil
}

func runCollector(ctx context.Context, config cleanupConfig, apply bool) (cleanupReport, error) {
	report := cleanupReport{DryRun: !apply, CandidateIDs: []string{}, DeletedIDs: []string{}, UnknownPaths: []string{}}
	if runtime.GOOS != "linux" {
		return report, errors.New("run the collector on the Linux E2B host; on macOS this is inside Lima")
	}
	host := newDockerHost(config)
	var journal *os.File
	if apply {
		if os.Geteuid() != 0 {
			return report, errors.New("physical collection must run as root on the Linux E2B host")
		}
		lock, err := acquireCollectorLock(hostCollectorLockPath)
		if err != nil {
			return report, err
		}
		defer lock.Close()
		journal, err = openJournal(config.JournalPath)
		if err != nil {
			return report, err
		}
		defer journal.Close()
	}
	if apply {
		recovered, err := recoverMaintenance(ctx, config)
		if recovered || err != nil {
			report.Skipped = "recovering interrupted host maintenance"
			report.ServicesRestored = recovered && err == nil
			return report, err
		}
	}
	if apply {
		// An empty preflight avoids bouncing idle services when no cleanup is
		// needed. It grants no deletion permission; apply repeats the complete
		// inventory after the host and catalogue are held static.
		skipped, restored, err := withIdleHost(ctx, host, false, func(collectionCtx context.Context, catalog catalogInventory, live []Root, _ func(context.Context) error) error {
			planned, _, _, err := planCollection(collectionCtx, config, catalog, live, time.Now())
			report = planned
			return err
		})
		report.DryRun = false
		report.ServicesRestored = restored
		report.Skipped = skipped
		if err != nil || skipped != "" || len(report.CandidateIDs) == 0 {
			if err == nil && skipped == "" {
				report.Skipped = "no old unused layers"
			}
			return report, err
		}
	}

	skipped, restored, err := withIdleHost(ctx, host, apply, func(collectionCtx context.Context, catalog catalogInventory, live []Root, checkLocked func(context.Context) error) error {
		planned, candidates, retained, err := planCollection(collectionCtx, config, catalog, live, time.Now())
		planned.DryRun = !apply
		report = planned
		if err != nil || !apply {
			return err
		}
		report.DeletedIDs, err = sweepStorage(collectionCtx, config.StoragePath, candidates, retained, journal, checkLocked)
		return err
	})
	report.Skipped = skipped
	report.ServicesRestored = restored
	return report, err
}

func main() {
	apply := flag.Bool("apply", false, "Reclaim unused layers during an idle-host window; default reports only")
	flag.Parse()
	config, err := decodeConfig(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	report, err := runCollector(ctx, config, *apply)
	var output bytes.Buffer
	if encodeErr := json.NewEncoder(&output).Encode(report); encodeErr == nil {
		os.Stdout.Write(output.Bytes())
	}
	if err != nil {
		// Subprocess failures are deliberately sanitized: Docker/SQL errors can contain credentials.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
