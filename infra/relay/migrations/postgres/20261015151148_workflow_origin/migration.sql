UPDATE "relay_workflow_jobs" SET "record" = "record" || jsonb_build_object('origin', jsonb_build_object('kind','manual','userId',"submitter_user_id")) WHERE NOT ("record" ? 'origin');--> statement-breakpoint
ALTER TABLE "relay_workflow_jobs" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "relay_workflow_jobs" ADD COLUMN "summary" jsonb GENERATED ALWAYS AS (jsonb_object(
        ARRAY['jobId','repositoryId','workflowId','environmentId','instruction','status','detail','createdAt','updatedAt'],
        ARRAY["job_id"::text,"repository_id"::text,"record"->>'workflowId',"record"->>'environmentId',left("record"->>'instruction',500),"status"::text,left("record"->>'detail',500),"created_at"::text,"record"->>'updatedAt']
      ) || CASE WHEN "status" IN ('awaiting_review','awaiting_input','paused')
        OR ("status" = 'queued' AND "record"->>'detail' IS NOT NULL)
        OR ("status" = 'cancelling' AND "record"#>>'{progress,retryableCancellation}' = 'true')
        THEN '{"needsAttention":true}'::jsonb ELSE '{"needsAttention":false}'::jsonb END
      || ('{"originSummary":' || (
        jsonb_object(ARRAY['kind'], ARRAY["record"#>>'{origin,kind}'])
        || CASE WHEN "record"#>>'{workflow,definition,name}' IS NOT NULL
          THEN jsonb_object(ARRAY['workflowName'], ARRAY[left("record"#>>'{workflow,definition,name}',120)])
          ELSE '{}'::jsonb END)::text || '}')::jsonb) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_workflow_jobs" ALTER COLUMN "submitter_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_workflow_jobs" ADD CONSTRAINT "workflow_job_origin" CHECK ((
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
        AND "record"->'requiredProtocol' = '8'::jsonb)
    ) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION relay_workflow_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Older manual writers omit origin. Only their real submitter can supply it.
  IF NOT (NEW.record ? 'origin') AND NEW.submitter_user_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.record#>>'{origin,kind}' = 'manual') THEN
    NEW.record = NEW.record || jsonb_build_object('origin', jsonb_build_object('kind','manual','userId',NEW.submitter_user_id));
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.record->'origin' IS DISTINCT FROM NEW.record->'origin' THEN
    RAISE EXCEPTION 'Workflow origin is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER relay_workflow_origin_guard BEFORE INSERT OR UPDATE ON relay_workflow_jobs
FOR EACH ROW EXECUTE FUNCTION relay_workflow_origin_guard();
