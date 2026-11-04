CREATE TABLE "relay_workflow_vm_attempts" (
	"job_id" text,
	"attempt_id" text,
	"identity" jsonb NOT NULL,
	CONSTRAINT "relay_workflow_vm_attempts_pkey" PRIMARY KEY("job_id","attempt_id")
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_provisions" ADD COLUMN "workflow_snapshot" jsonb;