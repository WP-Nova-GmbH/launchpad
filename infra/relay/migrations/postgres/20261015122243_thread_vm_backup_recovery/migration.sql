CREATE TABLE "relay_thread_vm_backup_recoveries" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"allocation_id" varchar(64) NOT NULL UNIQUE,
	"source_allocation_id" varchar(64) NOT NULL,
	"actor_user_id" varchar(191) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"generation" integer NOT NULL,
	"host_id" varchar(191) NOT NULL,
	"compute_ref" varchar(191) NOT NULL,
	"source_operation_id" varchar(64) NOT NULL,
	"backup_operation_id" varchar(64) NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"native_checkpoint_operation_id" varchar(64) NOT NULL,
	"native_relay_cursor" integer NOT NULL,
	"through_relay_cursor" integer NOT NULL,
	"through_command_position" integer NOT NULL,
	"source_template_id" varchar(191) NOT NULL,
	"source_build_id" varchar(64) NOT NULL,
	"independent_history" jsonb,
	"retention_receipt" jsonb,
	"stop_receipt" jsonb,
	"phase" varchar(16) NOT NULL,
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_vm_backup_recoveries_phase" CHECK ("phase" IN ('pending','retaining','retained','stopped','restoring','completed','cancelled')),
	CONSTRAINT "relay_thread_vm_backup_recoveries_cursors" CHECK ("generation">0 AND "native_relay_cursor">=0 AND "through_relay_cursor">="native_relay_cursor" AND "through_command_position">=0),
	CONSTRAINT "relay_thread_vm_backup_recoveries_retained" CHECK ("phase" NOT IN ('retained','stopped','restoring','completed') OR ("retention_receipt" IS NOT NULL AND "independent_history" IS NOT NULL)),
	CONSTRAINT "relay_thread_vm_backup_recoveries_stopped" CHECK ("phase" NOT IN ('stopped','restoring','completed') OR "stop_receipt" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backups" ADD COLUMN "capture_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "backup_recovery_operation_id" varchar(64);--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "probe_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ALTER COLUMN "saved_disk_operation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_backup_recovery_operation_id_key" UNIQUE("backup_recovery_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_backup_recoveries_active" ON "relay_thread_vm_backup_recoveries" ("thread_id") WHERE "phase" NOT IN ('completed','cancelled');--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_backup_recoveries_worker" ON "relay_thread_vm_backup_recoveries" ("host_id","phase","retry_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backup_recoveries" ADD CONSTRAINT "relay_thread_vm_backup_recoveries_mfFQyasfhlcL_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backup_recoveries" ADD CONSTRAINT "relay_thread_vm_backup_recoveries_ARdt164PzMFA_fkey" FOREIGN KEY ("source_allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backup_recoveries" ADD CONSTRAINT "relay_thread_vm_backup_recoveries_8ZGh7vnSguqF_fkey" FOREIGN KEY ("backup_operation_id") REFERENCES "relay_thread_vm_backups"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backup_recoveries" ADD CONSTRAINT "relay_thread_vm_backup_recoveries_bLym9bvqw7dx_fkey" FOREIGN KEY ("native_checkpoint_operation_id") REFERENCES "relay_thread_native_checkpoints"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_qtf6Iw7dOQ1H_fkey" FOREIGN KEY ("backup_recovery_operation_id") REFERENCES "relay_thread_vm_backup_recoveries"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_source" CHECK (("saved_disk_operation_id" IS NOT NULL) <> ("backup_recovery_operation_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_probe_attempt" CHECK ("probe_attempt">=0);