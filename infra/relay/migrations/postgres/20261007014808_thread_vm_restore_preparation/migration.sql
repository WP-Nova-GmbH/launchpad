CREATE TABLE "relay_thread_vm_restores" (
	"operation_id" varchar(64) PRIMARY KEY,
	"saved_disk_operation_id" varchar(64) NOT NULL,
	"thread_id" varchar(191) NOT NULL,
	"allocation_id" varchar(64) NOT NULL UNIQUE,
	"actor_user_id" varchar(191) NOT NULL,
	"generation" integer NOT NULL,
	"host_id" varchar(191) NOT NULL,
	"native_checkpoint_operation_id" varchar(64) NOT NULL,
	"source_template_id" varchar(191) NOT NULL,
	"source_build_id" varchar(64) NOT NULL,
	"phase" varchar(16) NOT NULL,
	"prepare_started_at" timestamp with time zone,
	"prepared_receipt" jsonb,
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_vm_restores_generation" CHECK ("generation" > 0),
	CONSTRAINT "relay_thread_vm_restores_phase" CHECK ("phase" IN ('pending','preparing','prepared','aborting','aborted')),
	CONSTRAINT "relay_thread_vm_restores_started" CHECK ("phase" NOT IN ('preparing','prepared') OR "prepare_started_at" IS NOT NULL),
	CONSTRAINT "relay_thread_vm_restores_prepared" CHECK ("phase" != 'prepared' OR "prepared_receipt" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_restores_active" ON "relay_thread_vm_restores" ("thread_id") WHERE "phase" != 'aborted';--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_restores_worker" ON "relay_thread_vm_restores" ("host_id","phase","retry_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_INIryYPIA0kC_fkey" FOREIGN KEY ("saved_disk_operation_id") REFERENCES "relay_thread_vm_saved_disks"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_6c0t6TFtGnka_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_rXYZCKiuoAzf_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_3xXz2DRY0FFY_fkey" FOREIGN KEY ("native_checkpoint_operation_id") REFERENCES "relay_thread_native_checkpoints"("operation_id");