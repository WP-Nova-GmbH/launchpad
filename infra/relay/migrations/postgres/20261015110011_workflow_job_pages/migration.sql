ALTER TABLE "relay_workflow_jobs" ADD COLUMN "summary" jsonb GENERATED ALWAYS AS (jsonb_object(
        ARRAY['jobId','repositoryId','workflowId','environmentId','instruction','status','detail','createdAt','updatedAt'],
        ARRAY["job_id"::text,"repository_id"::text,"record"->>'workflowId',"record"->>'environmentId',left("record"->>'instruction',500),"status"::text,left("record"->>'detail',500),"created_at"::text,"record"->>'updatedAt']
      ) || CASE WHEN "status" IN ('awaiting_review','awaiting_input','paused')
        OR ("status" = 'queued' AND "record"->>'detail' IS NOT NULL)
        OR ("status" = 'cancelling' AND "record"#>>'{progress,retryableCancellation}' = 'true')
        THEN '{"needsAttention":true}'::jsonb ELSE '{"needsAttention":false}'::jsonb END) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_active_page" ON "relay_workflow_jobs" ("repository_id","created_at","job_id") WHERE "status" NOT IN ('done','cancelled','failed');--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_history_page" ON "relay_workflow_jobs" ("repository_id","created_at","job_id") WHERE "status" IN ('done','cancelled','failed');