CREATE TABLE "relay_thread_vm_backup_recovery_cancellations" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"actor_user_id" varchar(191) NOT NULL,
	"request" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backup_recoveries" ADD COLUMN "retention_candidate" jsonb;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "preparation_cancellations" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backup_recovery_cancellations" ADD CONSTRAINT "vEYgmvFZbNkC_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");