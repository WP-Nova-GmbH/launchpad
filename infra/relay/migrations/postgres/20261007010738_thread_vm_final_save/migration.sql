CREATE TABLE "relay_thread_vm_final_saves" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"allocation_id" varchar(64) NOT NULL,
	"actor_user_id" varchar(191) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"generation" integer NOT NULL,
	"host_id" varchar(191) NOT NULL,
	"compute_ref" varchar(191) NOT NULL,
	"original_state" varchar(16) NOT NULL,
	"reason" varchar(16) NOT NULL,
	"activity_revision" integer NOT NULL,
	"idle_since" timestamp with time zone NOT NULL,
	"source_sequence" integer,
	"native_checkpoint_operation_id" varchar(64),
	"backup_operation_id" varchar(64),
	"phase" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "relay_thread_vm_final_saves_generation" CHECK ("generation" > 0),
	CONSTRAINT "relay_thread_vm_final_saves_phase" CHECK ("phase" IN ('draining','frozen','saving','deleting','completed','aborting','aborted')),
	CONSTRAINT "relay_thread_vm_final_saves_original_state" CHECK ("original_state" IN ('running','paused')),
	CONSTRAINT "relay_thread_vm_final_saves_reason" CHECK ("reason" IN ('idle','replacement')),
	CONSTRAINT "relay_thread_vm_final_saves_frozen" CHECK ("phase" NOT IN ('frozen','saving','deleting','completed') OR ("source_sequence" >= 0 AND "native_checkpoint_operation_id" IS NOT NULL AND "frozen_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_final_saves_active" ON "relay_thread_vm_final_saves" ("thread_id") WHERE "phase" NOT IN ('completed','aborted');--> statement-breakpoint
ALTER TABLE "relay_thread_vm_final_saves" ADD CONSTRAINT "relay_thread_vm_final_saves_5jbDM9XjgUGq_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_final_saves" ADD CONSTRAINT "relay_thread_vm_final_saves_gLWSAE0GP7XD_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_final_saves" ADD CONSTRAINT "relay_thread_vm_final_saves_B9biVZqCRPfw_fkey" FOREIGN KEY ("native_checkpoint_operation_id") REFERENCES "relay_thread_native_checkpoints"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_final_saves" ADD CONSTRAINT "relay_thread_vm_final_saves_Nizhsf2wUw12_fkey" FOREIGN KEY ("backup_operation_id") REFERENCES "relay_thread_vm_backups"("operation_id");