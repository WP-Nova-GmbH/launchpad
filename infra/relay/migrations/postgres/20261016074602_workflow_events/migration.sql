CREATE TABLE "relay_workflow_admissions" (
	"occurrence_id" text,
	"workflow_id" text,
	"job_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"grant_generation" integer NOT NULL,
	"authorization_epoch" integer NOT NULL,
	"workflow_revision" integer NOT NULL,
	"routing_generation" integer NOT NULL,
	CONSTRAINT "relay_workflow_admissions_pkey" PRIMARY KEY("occurrence_id","workflow_id")
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_occurrences" (
	"occurrence_id" text PRIMARY KEY,
	"application_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" text NOT NULL,
	"received_at" text NOT NULL,
	"facts" jsonb NOT NULL,
	"job_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "automation_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "source_application_id" text;--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "source_workspace_id" text;--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "trigger_team_id" text;--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "trigger_event" text;--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "trigger_grant_id" text;--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "routing_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "effective_after" text;--> statement-breakpoint
ALTER TABLE "relay_repository_workflows" ADD COLUMN "target_capability" jsonb;--> statement-breakpoint
ALTER TABLE "relay_workflow_authorizations" ADD COLUMN "started_at" text;--> statement-breakpoint
ALTER TABLE "relay_workflow_connections" ADD COLUMN "authorization_started_at" text;--> statement-breakpoint
ALTER TABLE "relay_workflow_connections" ADD COLUMN "delivery_evidence" jsonb;--> statement-breakpoint
CREATE INDEX "idx_workflow_event_rules" ON "relay_repository_workflows" ("source_application_id","source_workspace_id","trigger_team_id","trigger_event") WHERE automation_enabled;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_admission_job" ON "relay_workflow_admissions" ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_occurrence_identity" ON "relay_workflow_occurrences" ("application_id","workspace_id","event_key");--> statement-breakpoint
CREATE INDEX "workflow_revocation_cutoff" ON "relay_workflow_occurrences" ("application_id","workspace_id","event_type","occurred_at");
--> statement-breakpoint
-- An older writer omits automation and cannot validate a changed executor or action set.
-- Preserve criteria, but disable incompatible edits under the existing workflow row lock.
-- Only the new Save path can enable/change routing; it takes the source fence first.
CREATE FUNCTION relay_preserve_workflow_automation() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.record#>>'{definition,environmentId}' IS DISTINCT FROM OLD.record#>>'{definition,environmentId}'
      OR NEW.record#>>'{definition,projectId}' IS DISTINCT FROM OLD.record#>>'{definition,projectId}'
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
CREATE TRIGGER preserve_workflow_automation BEFORE UPDATE ON relay_repository_workflows
FOR EACH ROW EXECUTE FUNCTION relay_preserve_workflow_automation();
--> statement-breakpoint
ALTER TABLE relay_repository_workflows ADD CONSTRAINT workflow_routing_consistent CHECK (
  automation_enabled = COALESCE((record#>>'{automation,enabled}')::boolean, false)
  AND (NOT automation_enabled OR COALESCE((
    record->>'archived' = 'false' AND source_application_id IS NOT NULL
    AND source_workspace_id IS NOT NULL AND effective_after IS NOT NULL
    AND target_capability IS NOT NULL AND routing_generation > 0
    AND trigger_team_id IS NOT NULL AND trigger_grant_id IS NOT NULL
    AND trigger_event IN ('issue_created','entered_status')
    AND trigger_team_id = record#>>'{automation,trigger,teamId}'
    AND trigger_grant_id = record#>>'{automation,trigger,grantId}'
    AND trigger_event = record#>>'{automation,trigger,event}'
  ),false))
);
