ALTER TABLE "relay_thread_placements" ADD COLUMN "original_environment_id" varchar(191);--> statement-breakpoint
ALTER TABLE "relay_thread_placements" ADD COLUMN "original_project_id" varchar(191);--> statement-breakpoint
ALTER TABLE "relay_thread_placements" ADD CONSTRAINT "relay_thread_placements_original_location" CHECK (("original_environment_id" IS NULL) = ("original_project_id" IS NULL));--> statement-breakpoint
-- A generation-one local enrollment still has its authenticated source placement.
UPDATE relay_thread_placements t
SET original_environment_id = t.environment_id, original_project_id = t.project_id
FROM relay_thread_local_enrollments e
WHERE e.thread_id = t.thread_id AND e.phase IN ('preparing', 'active')
  AND t.generation = 1 AND t.original_environment_id IS NULL;--> statement-breakpoint
-- Moved local threads require retained creation history from their first committed source.
-- VM-created threads have no local enrollment, and incomplete evidence stays unknown.
WITH source AS (
  SELECT thread_id, min(environment_id) AS environment_id,
    min(event_json->'payload'->>'projectId') AS project_id
  FROM relay_thread_history
  WHERE event_json->>'type' = 'thread.created'
  GROUP BY thread_id
  HAVING count(*) = 1
    AND bool_and(jsonb_typeof(event_json->'payload'->'projectId') = 'string')
    AND length(min(event_json->'payload'->>'projectId')) BETWEEN 1 AND 191
)
UPDATE relay_thread_placements t
SET original_environment_id = source.environment_id, original_project_id = source.project_id
FROM relay_thread_local_enrollments e, source
WHERE e.thread_id = t.thread_id AND source.thread_id = t.thread_id
  AND e.phase = 'active' AND t.generation > 1 AND t.original_environment_id IS NULL
  AND EXISTS (
    SELECT 1 FROM relay_thread_moves m
    WHERE m.thread_id = t.thread_id AND m.expected_generation = 1
      AND m.phase IN ('committed', 'completed') AND m.source_environment_id = source.environment_id
  );
