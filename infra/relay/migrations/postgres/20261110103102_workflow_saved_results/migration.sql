CREATE TABLE "relay_workflow_recovery_heads" (
	"job_id" text PRIMARY KEY,
	"publication_id" text NOT NULL,
	"revision" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_recovery_records" (
	"publication_id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"revision" integer NOT NULL,
	"manifest_artifact_id" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"manifest_size_bytes" integer NOT NULL,
	"manifest" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_saved_results" (
	"result_id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"revision" integer NOT NULL,
	"result" jsonb NOT NULL,
	"native_checkpoint_operation_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_thread_deletions" ADD COLUMN "requester_user_id" varchar(191);--> statement-breakpoint
UPDATE "relay_thread_deletions" SET "requester_user_id"="owner_user_id";--> statement-breakpoint
ALTER TABLE "relay_thread_deletions" ALTER COLUMN "requester_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_deletions" ADD COLUMN "audience" varchar(16) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_deletions" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "relay_thread_deletions" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "relay_thread_deletions" ADD COLUMN "workflow_job_id" text;--> statement-breakpoint
ALTER TABLE "relay_thread_deletions" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_recovery_revision" ON "relay_workflow_recovery_records" ("job_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_saved_result_turn" ON "relay_workflow_saved_results" ("job_id","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_saved_result_order" ON "relay_workflow_saved_results" ("job_id","revision");