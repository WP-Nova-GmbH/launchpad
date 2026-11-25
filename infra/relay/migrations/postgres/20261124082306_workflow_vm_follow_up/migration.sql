CREATE TABLE "relay_workflow_vm_follow_up_baselines" (
	"job_id" varchar(64) PRIMARY KEY,
	"branch" text NOT NULL,
	"sha" text NOT NULL,
	"tree_sha" text NOT NULL,
	"base_sha" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_vm_follow_up_pushes" (
	"operation_id" text PRIMARY KEY,
	"job_id" varchar(64) NOT NULL,
	"actor_user_id" text NOT NULL,
	"generation" integer NOT NULL,
	"status" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_vm_follow_ups" (
	"job_id" varchar(64) PRIMARY KEY,
	"workspace_revision" bigint DEFAULT 0 NOT NULL,
	"operation_id" text,
	"actor_user_id" text,
	"allocation_id" text,
	"generation" integer,
	"requested_at" timestamp with time zone,
	"open_until" timestamp with time zone,
	"interactive_ready_generation" integer,
	"reclaim_operation_id" text,
	"reclaim_fallback" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_workflow_run_configurations" ALTER COLUMN "sealed_payload" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "idx_relay_thread_vm_saved_disks_current";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_saved_disks_current" ON "relay_thread_vm_saved_disks" ("thread_id") WHERE "phase" IN ('available','restoring');--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_vm_one_follow_up_push" ON "relay_workflow_vm_follow_up_pushes" ("job_id") WHERE status IN ('preparing','armed','pending');--> statement-breakpoint
ALTER TABLE "relay_workflow_vm_follow_up_baselines" ADD CONSTRAINT "relay_workflow_vm_follow_up_baselines_Fx734nIyCP61_fkey" FOREIGN KEY ("job_id") REFERENCES "relay_workflow_jobs"("job_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relay_workflow_vm_follow_up_pushes" ADD CONSTRAINT "relay_workflow_vm_follow_up_pushes_Z34VPgJzfN1J_fkey" FOREIGN KEY ("job_id") REFERENCES "relay_workflow_jobs"("job_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relay_workflow_vm_follow_ups" ADD CONSTRAINT "relay_workflow_vm_follow_ups_vEyZSmPyjpmz_fkey" FOREIGN KEY ("job_id") REFERENCES "relay_workflow_jobs"("job_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relay_thread_artifacts" DROP CONSTRAINT "relay_thread_artifacts_kind", ADD CONSTRAINT "relay_thread_artifacts_kind" CHECK ("kind" IN ('workspace','native','attachment','history','manifest','follow-up-push'));