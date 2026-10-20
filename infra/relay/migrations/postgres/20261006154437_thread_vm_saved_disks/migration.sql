CREATE TABLE "relay_thread_vm_saved_disks" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"backup_operation_id" varchar(64) NOT NULL UNIQUE,
	"generation" integer NOT NULL,
	"host_id" varchar(64) NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase" varchar(16) NOT NULL,
	"restore_operation_id" varchar(64) UNIQUE,
	"restore_allocation_id" varchar(64),
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_vm_saved_disks_generation" CHECK ("generation" > 0),
	CONSTRAINT "relay_thread_vm_saved_disks_phase" CHECK ("phase" IN ('available','restoring','restored','expiring','expired')),
	CONSTRAINT "relay_thread_vm_saved_disks_restore" CHECK ("phase" != 'restoring' OR ("restore_operation_id" IS NOT NULL AND "restore_allocation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_saved_disks_current" ON "relay_thread_vm_saved_disks" ("thread_id") WHERE "phase" IN ('available','restoring','expiring');--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_saved_disks_expiry" ON "relay_thread_vm_saved_disks" ("host_id","phase","saved_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_saved_disks" ADD CONSTRAINT "relay_thread_vm_saved_disks_9yKL66YXwKhB_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_saved_disks" ADD CONSTRAINT "relay_thread_vm_saved_disks_Ry8oMc4balCd_fkey" FOREIGN KEY ("backup_operation_id") REFERENCES "relay_thread_vm_backups"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_saved_disks" ADD CONSTRAINT "relay_thread_vm_saved_disks_7WuXHBvSLzhH_fkey" FOREIGN KEY ("restore_allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");