package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
)

// This SELECT uses one PostgreSQL snapshot and reads only stock E2B tables.
// Keep older assigned builds because E2B accepts build UUIDs as start targets.
// Failed builds retain assignments after E2B removes their artifacts, but cannot
// start. Exclude only known failures; unknown/missing records remain fail-closed.
// Database roots do not account for running VMs, caches, or unfinished uploads.
const catalogInventorySQL = `
WITH assigned_roots AS (
    SELECT a.build_id, COALESCE(b.filesystem_only, FALSE) AS filesystem_only,
           CASE WHEN e.source = 'snapshot' THEN 'paused-snapshot-assignment'
                ELSE 'template-assignment' END AS reason
    FROM public.active_envs e
    JOIN public.env_build_assignments a ON a.env_id = e.id
    LEFT JOIN public.env_builds b ON b.id = a.build_id
    WHERE b.status_group IS DISTINCT FROM 'failed'
), explicit_snapshot_roots AS (
    SELECT s.build_id, COALESCE(b.filesystem_only, FALSE) AS filesystem_only,
           'snapshot-template'::text AS reason
    FROM public.snapshot_templates s
    JOIN public.active_envs e ON e.id = s.env_id
    LEFT JOIN public.env_builds b ON b.id = s.build_id
    WHERE s.build_id IS NOT NULL AND b.status_group IS DISTINCT FROM 'failed'
), active_build_roots AS (
    SELECT a.build_id, COALESCE(b.filesystem_only, FALSE) AS filesystem_only,
           'active-build'::text AS reason
    FROM public.active_template_builds a
    LEFT JOIN public.env_builds b ON b.id = a.build_id
), unfinished_builds AS (
    SELECT id AS build_id, COALESCE(filesystem_only, FALSE) AS filesystem_only,
           'unfinished-build'::text AS reason
    FROM public.env_builds
    WHERE status_group IN ('pending', 'in_progress')
), roots AS (
    SELECT * FROM assigned_roots
    UNION SELECT * FROM explicit_snapshot_roots
    UNION SELECT * FROM active_build_roots
    UNION SELECT * FROM unfinished_builds
), issues AS (
    SELECT 'assigned-build-missing'::text AS kind, a.build_id::text AS record_id
    FROM public.active_envs e
    JOIN public.env_build_assignments a ON a.env_id = e.id
    LEFT JOIN public.env_builds b ON b.id = a.build_id
    WHERE b.id IS NULL
    UNION
    SELECT 'snapshot-template-build-missing', s.env_id
    FROM public.snapshot_templates s
    JOIN public.active_envs e ON e.id = s.env_id
    LEFT JOIN public.env_builds b ON b.id = s.build_id
    WHERE (s.build_id IS NOT NULL AND b.id IS NULL)
       OR (s.build_id IS NULL AND NOT EXISTS (
           SELECT 1 FROM public.env_build_assignments a WHERE a.env_id = s.env_id
       ))
    UNION
    SELECT 'snapshot-assignment-missing', s.env_id
    FROM public.snapshots s
    JOIN public.active_envs e ON e.id = s.env_id
    WHERE NOT EXISTS (
        SELECT 1 FROM public.env_build_assignments a WHERE a.env_id = s.env_id
    )
    UNION
    SELECT 'snapshot-record-missing', e.id
    FROM public.active_envs e
    WHERE (e.source = 'snapshot' AND NOT EXISTS (
              SELECT 1 FROM public.snapshots s WHERE s.env_id = e.id
          ))
       OR (e.source = 'snapshot_template' AND NOT EXISTS (
              SELECT 1 FROM public.snapshot_templates s WHERE s.env_id = e.id
          ))
    UNION
    SELECT 'active-build-record-missing', a.build_id::text
    FROM public.active_template_builds a
    LEFT JOIN public.env_builds b ON b.id = a.build_id
    WHERE b.id IS NULL
)
SELECT json_build_object(
    'schemaVersion', 1,
    'roots', COALESCE((
        SELECT json_agg(json_build_object(
            'buildId', build_id::text, 'filesystemOnly', filesystem_only, 'reason', reason
        ) ORDER BY build_id, reason) FROM roots
    ), '[]'::json),
    'unfinishedBuildIds', COALESCE((
        SELECT json_agg(build_id::text ORDER BY build_id) FROM unfinished_builds
    ), '[]'::json),
    'issues', COALESCE((
        SELECT json_agg(json_build_object('kind', kind, 'recordId', record_id)
                        ORDER BY kind, record_id) FROM issues
    ), '[]'::json)
);`

type catalogRoot struct {
	BuildID        string `json:"buildId"`
	FilesystemOnly bool   `json:"filesystemOnly"`
	Reason         string `json:"reason"`
}

type catalogIssue struct {
	Kind     string `json:"kind"`
	RecordID string `json:"recordId"`
}

type catalogInventory struct {
	SchemaVersion      int            `json:"schemaVersion"`
	Roots              []catalogRoot  `json:"roots"`
	UnfinishedBuildIDs []string       `json:"unfinishedBuildIds"`
	Issues             []catalogIssue `json:"issues"`
}

func parseCatalogInventory(data []byte) (catalogInventory, error) {
	var wire struct {
		SchemaVersion *int `json:"schemaVersion"`
		Roots         *[]struct {
			BuildID        string `json:"buildId"`
			FilesystemOnly *bool  `json:"filesystemOnly"`
			Reason         string `json:"reason"`
		} `json:"roots"`
		UnfinishedBuildIDs *[]string       `json:"unfinishedBuildIds"`
		Issues             *[]catalogIssue `json:"issues"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return catalogInventory{}, fmt.Errorf("decode native catalog inventory: %w", err)
	}
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return catalogInventory{}, errors.New("native catalog inventory must contain exactly one JSON object")
	}
	if wire.SchemaVersion == nil || *wire.SchemaVersion != 1 || wire.Roots == nil ||
		wire.UnfinishedBuildIDs == nil || wire.Issues == nil {
		return catalogInventory{}, errors.New("native catalog inventory requires schemaVersion 1 and non-null roots, unfinishedBuildIds, issues arrays")
	}
	result := catalogInventory{SchemaVersion: 1, Roots: []catalogRoot{}, UnfinishedBuildIDs: []string{}, Issues: []catalogIssue{}}
	rootSet := map[catalogRoot]struct{}{}
	unfinishedRoots := map[string]struct{}{}
	for _, root := range *wire.Roots {
		if !validBuildID(root.BuildID) || root.FilesystemOnly == nil {
			return catalogInventory{}, errors.New("native catalog root requires a canonical non-nil build UUID and filesystemOnly boolean")
		}
		switch root.Reason {
		case "template-assignment", "paused-snapshot-assignment", "snapshot-template", "active-build", "unfinished-build":
		default:
			return catalogInventory{}, fmt.Errorf("unknown native catalog root reason %q", root.Reason)
		}
		if root.Reason == "unfinished-build" {
			unfinishedRoots[root.BuildID] = struct{}{}
		}
		rootSet[catalogRoot{root.BuildID, *root.FilesystemOnly, root.Reason}] = struct{}{}
	}
	for root := range rootSet {
		result.Roots = append(result.Roots, root)
	}
	sort.Slice(result.Roots, func(i, j int) bool {
		a, b := result.Roots[i], result.Roots[j]
		if a.BuildID != b.BuildID {
			return a.BuildID < b.BuildID
		}
		if a.Reason != b.Reason {
			return a.Reason < b.Reason
		}
		return !a.FilesystemOnly && b.FilesystemOnly
	})
	unfinishedSet := map[string]struct{}{}
	for _, id := range *wire.UnfinishedBuildIDs {
		if !validBuildID(id) {
			return catalogInventory{}, fmt.Errorf("invalid unfinished native build ID %q", id)
		}
		if _, ok := unfinishedRoots[id]; !ok {
			return catalogInventory{}, fmt.Errorf("unfinished native build %s has no matching root", id)
		}
		unfinishedSet[id] = struct{}{}
	}
	if len(unfinishedSet) != len(unfinishedRoots) {
		return catalogInventory{}, errors.New("native unfinished-build roots and unfinishedBuildIds disagree")
	}
	for id := range unfinishedSet {
		result.UnfinishedBuildIDs = append(result.UnfinishedBuildIDs, id)
	}
	sort.Strings(result.UnfinishedBuildIDs)
	issueSet := map[catalogIssue]struct{}{}
	for _, issue := range *wire.Issues {
		switch issue.Kind {
		case "assigned-build-missing", "snapshot-template-build-missing", "snapshot-assignment-missing", "snapshot-record-missing", "active-build-record-missing":
		default:
			return catalogInventory{}, fmt.Errorf("unknown native catalog issue %q", issue.Kind)
		}
		if issue.RecordID == "" {
			return catalogInventory{}, errors.New("native catalog issue requires recordId")
		}
		issueSet[issue] = struct{}{}
	}
	for issue := range issueSet {
		result.Issues = append(result.Issues, issue)
	}
	sort.Slice(result.Issues, func(i, j int) bool {
		a, b := result.Issues[i], result.Issues[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.RecordID < b.RecordID
	})
	return result, nil
}
