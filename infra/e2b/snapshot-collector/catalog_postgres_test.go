package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Opt-in integration against a separately created, labelled, RAM-backed
// PostgreSQL fixture. Never point this at an E2B or user database.
func TestPostgresCatalogAndHeldTransaction(t *testing.T) {
	id, token := os.Getenv("LAUNCHPAD_COLLECTOR_SQL_FIXTURE"), os.Getenv("LAUNCHPAD_COLLECTOR_SQL_TOKEN")
	if id == "" || token == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	if !validContainerID(id) {
		t.Fatal("invalid fixture identity")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	data, err := docker(ctx, "inspect", id)
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []dockerContainer
	if json.Unmarshal(data, &fixtures) != nil || len(fixtures) != 1 || fixtures[0].Config.Labels["io.launchpad.collector-sql-fixture"] != token || environment(fixtures[0], "POSTGRES_DB") != "collector_fixture" {
		t.Fatal("refusing an unowned database")
	}
	ddl := `
CREATE TABLE envs(id text PRIMARY KEY,source text,deleted_at timestamptz);
CREATE VIEW active_envs AS SELECT * FROM envs WHERE deleted_at IS NULL;
CREATE TABLE env_builds(id uuid PRIMARY KEY,filesystem_only boolean,status_group text);
CREATE TABLE env_build_assignments(env_id text,build_id uuid);
CREATE TABLE snapshot_templates(env_id text,build_id uuid);
CREATE TABLE active_template_builds(build_id uuid);
CREATE TABLE snapshots(env_id text,sandbox_id text);
INSERT INTO envs VALUES('template','template',NULL),('paused','snapshot',NULL),('saved','snapshot_template',NULL),('deleted','template',now()),('failed-saved','snapshot_template',NULL);
INSERT INTO env_builds VALUES
('00000000-0000-0000-0000-000000000001',false,'ready'),
('00000000-0000-0000-0000-000000000002',false,'ready'),
('00000000-0000-0000-0000-000000000003',true,'ready'),
('00000000-0000-0000-0000-000000000004',false,'ready'),
('00000000-0000-0000-0000-000000000005',false,'ready'),
('00000000-0000-0000-0000-000000000006',false,'pending'),
('00000000-0000-0000-0000-000000000007',false,'failed'),
('00000000-0000-0000-0000-000000000008',false,'failed');
INSERT INTO env_build_assignments VALUES
('template','00000000-0000-0000-0000-000000000001'),
('template','00000000-0000-0000-0000-000000000002'),
('paused','00000000-0000-0000-0000-000000000003'),
('deleted','00000000-0000-0000-0000-000000000005'),
('template','00000000-0000-0000-0000-000000000007');
INSERT INTO snapshots VALUES('paused','paused-vm');
INSERT INTO snapshot_templates VALUES
('saved','00000000-0000-0000-0000-000000000004'),
('failed-saved','00000000-0000-0000-0000-000000000008');
`
	execute := func(statement string) {
		t.Helper()
		command := exec.CommandContext(ctx, "docker", "exec", "-i", id, "psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "collector_fixture")
		command.Stdin = strings.NewReader(statement)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("fixture SQL: %v: %s", err, output)
		}
	}
	execute(ddl)
	for _, freeze := range []bool{false, true} {
		err := withDockerCatalog(ctx, id, freeze, func(scoped context.Context, inventory catalogInventory, check func(context.Context) error) error {
			if len(inventory.Issues) != 0 || len(inventory.UnfinishedBuildIDs) != 1 {
				t.Fatalf("unexpected catalogue diagnostics: %+v", inventory)
			}
			seen := map[string]bool{}
			for _, root := range inventory.Roots {
				seen[root.BuildID] = true
			}
			for _, suffix := range []string{"1", "2", "3", "4", "6"} {
				if !seen["00000000-0000-0000-0000-00000000000"+suffix] {
					t.Fatalf("required native build %s omitted", suffix)
				}
			}
			if seen["00000000-0000-0000-0000-000000000005"] {
				t.Fatal("retired template remained a root")
			}
			for _, suffix := range []string{"7", "8"} {
				if seen["00000000-0000-0000-0000-00000000000"+suffix] {
					t.Fatalf("terminal-failed build %s remained a restorable root", suffix)
				}
			}
			if freeze {
				writer := exec.CommandContext(scoped, "docker", "exec", id, "psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "collector_fixture", "-c", "BEGIN; LOCK TABLE public.envs IN ROW EXCLUSIVE MODE NOWAIT;")
				output, err := writer.CombinedOutput()
				if err == nil || !strings.Contains(string(output), "could not obtain lock") {
					t.Fatalf("catalogue writer was not fenced: %v: %s", err, output)
				}
			}
			return check(scoped)
		})
		if err != nil {
			t.Fatal("native query/transaction guard failed:", err)
		}
	}

	// Native failures retain their assignments but remove their own artifacts.
	// A later ready build must remain collectible without those missing headers.
	fixture := newCollectionFixture(t)
	execute(`
TRUNCATE envs,env_builds,env_build_assignments,snapshot_templates,active_template_builds,snapshots;
INSERT INTO envs VALUES('template','template',NULL),('failed-saved','snapshot_template',NULL);
INSERT INTO env_builds VALUES
('` + storedRootID + `',false,'ready'),
('` + collectionSecondRoot + `',false,'ready'),
('00000000-0000-0000-0000-000000000007',false,'failed'),
('00000000-0000-0000-0000-000000000008',false,'failed');
INSERT INTO env_build_assignments VALUES
('template','` + storedRootID + `'),
('template','` + collectionSecondRoot + `'),
('template','00000000-0000-0000-0000-000000000007');
INSERT INTO snapshot_templates VALUES('failed-saved','00000000-0000-0000-0000-000000000008');
`)
	err = withDockerCatalog(ctx, id, true, func(scoped context.Context, inventory catalogInventory, check func(context.Context) error) error {
		report, candidates, retained, err := planCollection(scoped, fixture.config, inventory, nil, time.Now().Add(2*time.Hour))
		if err != nil {
			return err
		}
		if report.RetainedLayers != 4 || len(candidates) != 1 || candidates[0].BuildID != collectionUnused {
			t.Fatalf("failed history changed retained layers or blocked cleanup: %+v", report)
		}
		var journal bytes.Buffer
		deleted, err := sweepStorage(scoped, fixture.stored.path, candidates, retained, &journal, check)
		if err == nil && (len(deleted) != 1 || deleted[0] != collectionUnused) {
			t.Fatalf("failed history prevented unused-layer collection: %v", deleted)
		}
		fixture.requireMappedBytes(t)
		return err
	})
	if err != nil {
		t.Fatal("collection with failed-build history:", err)
	}

	// Exclude only confirmed failures. Unknown and missing build records still
	// retain their roots, so missing bytes cannot become deletion permission.
	for _, status := range []string{"NULL", "'future-status'"} {
		execute("UPDATE env_builds SET status_group=" + status + " WHERE id='00000000-0000-0000-0000-000000000007';")
		err = withDockerCatalog(ctx, id, false, func(scoped context.Context, inventory catalogInventory, _ func(context.Context) error) error {
			if _, _, _, err := planCollection(scoped, fixture.config, inventory, nil, time.Now().Add(2*time.Hour)); err == nil {
				t.Fatal("unknown build status with missing artifacts authorized collection")
			}
			return nil
		})
		if err != nil {
			t.Fatal("unknown build status inventory:", err)
		}
	}
	execute("DELETE FROM env_builds WHERE id IN ('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000008');")
	err = withDockerCatalog(ctx, id, false, func(scoped context.Context, inventory catalogInventory, _ func(context.Context) error) error {
		if len(inventory.Issues) != 2 {
			t.Fatalf("missing assigned/snapshot build diagnostics lost: %+v", inventory)
		}
		if _, _, _, err := planCollection(scoped, fixture.config, inventory, nil, time.Now().Add(2*time.Hour)); err == nil {
			t.Fatal("missing assigned/snapshot build records authorized collection")
		}
		return nil
	})
	if err != nil {
		t.Fatal("missing build record inventory:", err)
	}
}
