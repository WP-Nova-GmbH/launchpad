CREATE TABLE "relay_repository_workflows" (
	"workflow_id" varchar(64) PRIMARY KEY,
	"repository_id" varchar(64) NOT NULL,
	"revision" integer NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_jobs" (
	"job_id" varchar(64) PRIMARY KEY,
	"repository_id" varchar(64) NOT NULL,
	"organization_id" varchar(64) NOT NULL,
	"submitter_user_id" varchar(191) NOT NULL,
	"repository_canonical_key" text,
	"status" varchar(32) NOT NULL,
	"record" jsonb NOT NULL,
	"pending_control" jsonb,
	"revision" integer NOT NULL,
	"lease_until" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"checked_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_repository_workflows_repository" ON "relay_repository_workflows" ("repository_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_repository" ON "relay_workflow_jobs" ("repository_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_status" ON "relay_workflow_jobs" ("status","checked_at");