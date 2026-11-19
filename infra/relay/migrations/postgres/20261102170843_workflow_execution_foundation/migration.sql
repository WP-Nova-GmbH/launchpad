ALTER TABLE "relay_thread_placements" ADD COLUMN "audience" varchar(16) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_placements" ADD COLUMN "workflow_job_id" varchar(64);--> statement-breakpoint
ALTER TABLE "relay_thread_vm_allocations" ADD COLUMN "resource_kind" varchar(32) DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_policies" ADD COLUMN "workflow_policy_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_policies" ADD COLUMN "max_running_workflow_vms" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_workflow_jobs" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "relay_workflow_jobs" ADD COLUMN "summary" jsonb GENERATED ALWAYS AS (jsonb_object(
        ARRAY['jobId','repositoryId','workflowId','instruction','status','detail','createdAt','updatedAt'],
        ARRAY["job_id"::text,"repository_id"::text,"record"->>'workflowId',left(CASE WHEN "record"->'event' IS NOT NULL THEN COALESCE("record"#>>'{issueSnapshot,identifier}',"record"#>>'{event,identifier}') || ': ' || COALESCE("record"#>>'{issueSnapshot,title}',"record"#>>'{event,title}') ELSE "record"->>'instruction' END,500),"status"::text,left("record"->>'detail',500),"created_at"::text,"record"->>'updatedAt']
      ) || ('{"runtime":' || COALESCE("record"->'runtime','null'::jsonb)::text || '}')::jsonb
      || CASE WHEN "status" IN ('awaiting_review','awaiting_input','paused')
        OR ("status" = 'queued' AND CASE WHEN "record" ? 'queueReason' THEN COALESCE("record"#>>'{queueReason,code}' NOT IN ('environment_offline','environment_busy','source_unavailable','source_rate_limited','workflow_changed'),false) ELSE "record"->>'detail' IS NOT NULL END)
        OR ("status" = 'cancelling' AND "record"#>>'{progress,retryableCancellation}' = 'true')
        THEN '{"needsAttention":true}'::jsonb ELSE '{"needsAttention":false}'::jsonb END
      || ('{"originSummary":' || (
        jsonb_object(ARRAY['kind'], ARRAY["record"#>>'{origin,kind}'])
        || CASE WHEN "record"#>>'{workflow,definition,name}' IS NOT NULL
          THEN jsonb_object(ARRAY['workflowName'], ARRAY[left("record"#>>'{workflow,definition,name}',120)])
          ELSE '{}'::jsonb END)::text || '}')::jsonb
      || CASE WHEN "record" ? 'queueReason' THEN ('{"queueReason":' || ("record"->'queueReason')::text || '}')::jsonb ELSE '{}'::jsonb END) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_placements" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_placements" ALTER COLUMN "environment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_placements" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_allocations" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_placements_tenant" ON "relay_thread_placements" ("thread_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_placements_workflow_job" ON "relay_thread_placements" ("workflow_job_id") WHERE "workflow_job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_jobs_tenant" ON "relay_workflow_jobs" ("job_id","organization_id","repository_id");--> statement-breakpoint
ALTER TABLE "relay_thread_placements" ADD CONSTRAINT "relay_thread_placements_workflow_job_tenant_fk" FOREIGN KEY ("workflow_job_id","organization_id","repository_id") REFERENCES "relay_workflow_jobs"("job_id","organization_id","repository_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_allocations" ADD CONSTRAINT "relay_thread_vm_allocations_placement_tenant_fk" FOREIGN KEY ("thread_id","organization_id") REFERENCES "relay_thread_placements"("thread_id","organization_id");--> statement-breakpoint
ALTER TABLE "relay_thread_placements" ADD CONSTRAINT "relay_thread_placements_audience" CHECK (("audience" = 'private' AND "owner_user_id" IS NOT NULL
        AND "workflow_job_id" IS NULL AND "environment_id" IS NOT NULL AND "project_id" IS NOT NULL)
      OR ("audience" = 'repository' AND "owner_user_id" IS NULL AND "workflow_job_id" IS NOT NULL
        AND (("environment_id" IS NOT NULL AND "project_id" IS NOT NULL)
          OR ("environment_id" IS NULL AND "project_id" IS NULL AND "generation" = 1
            AND "operation_id" IS NOT NULL AND "original_environment_id" IS NULL AND "original_project_id" IS NULL))));--> statement-breakpoint
ALTER TABLE "relay_thread_vm_allocations" ADD CONSTRAINT "relay_thread_vm_allocations_resource_owner" CHECK (("resource_kind" = 'personal' AND "owner_user_id" IS NOT NULL)
        OR ("resource_kind" = 'organization_workflow' AND "owner_user_id" IS NULL));--> statement-breakpoint
ALTER TABLE "relay_thread_vm_policies" DROP CONSTRAINT "relay_thread_vm_policies_limits", ADD CONSTRAINT "relay_thread_vm_policies_limits" CHECK ("revision" > 0 AND "max_vms_per_user" >= 0 AND "workflow_policy_revision" > 0 AND "max_running_workflow_vms" >= 0 AND "pause_after_idle_minutes" > 0 AND "delete_after_idle_weekdays" > 0 AND "backup_interval_minutes" > 0 AND "saved_disk_retention_days" > 0);--> statement-breakpoint
ALTER TABLE "relay_workflow_jobs" DROP CONSTRAINT "workflow_job_origin", ADD CONSTRAINT "workflow_job_origin" CHECK ((
      ("record"#>>'{origin,kind}' = 'manual' AND "submitter_user_id" IS NOT NULL
        AND "record"#>>'{origin,userId}' = "submitter_user_id")
      OR ("record"#>>'{origin,kind}' = 'automation' AND "submitter_user_id" IS NULL
        AND "record"#>>'{origin,organizationId}' = "organization_id"
        AND "record"#>>'{origin,repositoryId}' = "repository_id"
        AND "record"#>>'{origin,workflowId}' = "record"->>'workflowId'
        AND "record"#>>'{origin,source,provider}' = 'linear'
        AND length(trim("record"#>>'{origin,source,applicationId}')) > 0
        AND length(trim("record"#>>'{origin,source,workspaceId}')) > 0
        AND length(trim("record"#>>'{origin,source,connectionId}')) > 0
        AND length(trim("record"#>>'{origin,source,grantId}')) > 0
        AND length(trim("record"#>>'{origin,occurrenceId}')) > 0
        AND "record"->'requiredProtocol' IN ('8'::jsonb,'9'::jsonb))
    ) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION relay_preserve_workflow_automation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_actions text[];
  new_actions text[];
BEGIN
  IF NOT (NEW.record ? 'automation') AND OLD.record ? 'automation' THEN
    NEW.record := NEW.record || jsonb_build_object('automation', OLD.record->'automation');
    SELECT array_agg(DISTINCT step->>'action' ORDER BY step->>'action') INTO old_actions
      FROM jsonb_array_elements(OLD.record#>'{definition,steps}') AS step WHERE step->>'kind'='action';
    SELECT array_agg(DISTINCT step->>'action' ORDER BY step->>'action') INTO new_actions
      FROM jsonb_array_elements(NEW.record#>'{definition,steps}') AS step WHERE step->>'kind'='action';
    IF COALESCE(NEW.record#>'{definition,target}', jsonb_build_object('kind','machine',
        'environmentId',NEW.record#>'{definition,environmentId}',
        'projectId',NEW.record#>'{definition,projectId}'))
      IS DISTINCT FROM COALESCE(OLD.record#>'{definition,target}', jsonb_build_object('kind','machine',
        'environmentId',OLD.record#>'{definition,environmentId}',
        'projectId',OLD.record#>'{definition,projectId}'))
      OR new_actions IS DISTINCT FROM old_actions THEN
      NEW.automation_enabled := false;
      NEW.record := jsonb_set(NEW.record, '{automation,enabled}', 'false'::jsonb);
      NEW.target_capability := NULL;
    END IF;
  END IF;
  IF NEW.record->>'archived' = 'true' THEN
    NEW.automation_enabled := false;
    IF NEW.record ? 'automation' THEN
      NEW.record := jsonb_set(NEW.record, '{automation,enabled}', 'false'::jsonb);
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
UPDATE "relay_repository_workflows"
SET "record" = jsonb_set("record", '{definition}',
  (("record"->'definition') - 'environmentId' - 'projectId') || jsonb_build_object('target',
    jsonb_build_object('kind','machine',
      'environmentId',"record"#>'{definition,environmentId}',
      'projectId',"record"#>'{definition,projectId}')))
WHERE jsonb_typeof("record"->'definition') = 'object'
  AND NOT ("record"->'definition' ? 'target');
--> statement-breakpoint
UPDATE "relay_workflow_jobs"
SET "record" = jsonb_set("record", '{workflow,definition}',
  (("record"#>'{workflow,definition}') - 'environmentId' - 'projectId') || jsonb_build_object('target',
    jsonb_build_object('kind','machine',
      'environmentId',"record"#>'{workflow,definition,environmentId}',
      'projectId',"record"#>'{workflow,definition,projectId}')))
WHERE jsonb_typeof("record"#>'{workflow,definition}') = 'object'
  AND NOT ("record"#>'{workflow,definition}' ? 'target');
--> statement-breakpoint
UPDATE "relay_workflow_jobs"
SET "record" = ("record" - 'environmentId') || jsonb_build_object('runtime',
  CASE WHEN "record" ? 'runtime' THEN "record"->'runtime'
    WHEN "record"#>>'{workflow,definition,target,kind}' = 'machine'
      THEN "record"#>'{workflow,definition,target}'
    ELSE 'null'::jsonb END)
WHERE "record" ? 'environmentId' OR NOT ("record" ? 'runtime');
