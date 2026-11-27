ALTER TABLE "relay_workflow_jobs" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "relay_workflow_jobs" ADD COLUMN "summary" jsonb GENERATED ALWAYS AS (jsonb_object(
        ARRAY['jobId','repositoryId','workflowId','environmentId','instruction','status','detail','createdAt','updatedAt'],
        ARRAY["job_id"::text,"repository_id"::text,"record"->>'workflowId',"record"->>'environmentId',left(CASE WHEN "record"->'event' IS NOT NULL THEN COALESCE("record"#>>'{issueSnapshot,identifier}',"record"#>>'{event,identifier}') || ': ' || COALESCE("record"#>>'{issueSnapshot,title}',"record"#>>'{event,title}') ELSE "record"->>'instruction' END,500),"status"::text,left("record"->>'detail',500),"created_at"::text,"record"->>'updatedAt']
      ) || CASE WHEN "status" IN ('awaiting_review','awaiting_input','paused')
        OR ("status" = 'queued' AND CASE WHEN "record" ? 'queueReason' THEN COALESCE("record"#>>'{queueReason,code}' NOT IN ('environment_offline','environment_busy','source_unavailable','source_rate_limited','workflow_changed'),false) ELSE "record"->>'detail' IS NOT NULL END)
        OR ("status" = 'cancelling' AND "record"#>>'{progress,retryableCancellation}' = 'true')
        THEN '{"needsAttention":true}'::jsonb ELSE '{"needsAttention":false}'::jsonb END
      || ('{"originSummary":' || (
        jsonb_object(ARRAY['kind'], ARRAY["record"#>>'{origin,kind}'])
        || CASE WHEN "record"#>>'{workflow,definition,name}' IS NOT NULL
          THEN jsonb_object(ARRAY['workflowName'], ARRAY[left("record"#>>'{workflow,definition,name}',120)])
          ELSE '{}'::jsonb END)::text || '}')::jsonb
      || CASE WHEN "record" ? 'queueReason' THEN ('{"queueReason":' || ("record"->'queueReason')::text || '}')::jsonb ELSE '{}'::jsonb END ) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_workflow_admissions_connection" ON "relay_workflow_admissions" ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_dispatch_pending" ON "relay_workflow_jobs" ("checked_at","created_at") WHERE "status" NOT IN ('done','cancelled','failed');