CREATE TABLE "relay_workflow_vm_publications" (
	"ordinal" bigserial UNIQUE,
	"job_id" varchar(64),
	"action_id" text,
	"record" jsonb NOT NULL,
	"commit_object" text,
	CONSTRAINT "relay_workflow_vm_publications_pkey" PRIMARY KEY("job_id","action_id")
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_vm_publish_commands" (
	"command_id" text PRIMARY KEY,
	"job_id" varchar(64) NOT NULL,
	"action_id" text NOT NULL,
	"allocation_id" varchar(64) NOT NULL,
	"generation" integer NOT NULL,
	"pid" integer NOT NULL,
	"process_identity" text NOT NULL,
	"stopped_at" timestamp with time zone,
	"authorization_rejected_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "publishing_action_id" text;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "publishing_expected_revision" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_vm_one_publish_command" ON "relay_workflow_vm_publish_commands" ("job_id") WHERE stopped_at IS NULL;--> statement-breakpoint
ALTER TABLE "relay_workflow_vm_publications" ADD CONSTRAINT "relay_workflow_vm_publications_ajehmr9VKWfc_fkey" FOREIGN KEY ("job_id") REFERENCES "relay_workflow_jobs"("job_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relay_workflow_vm_publish_commands" ADD CONSTRAINT "relay_workflow_vm_publish_commands_lfTEEn3rMbEI_fkey" FOREIGN KEY ("job_id","action_id") REFERENCES "relay_workflow_vm_publications"("job_id","action_id") ON DELETE CASCADE;