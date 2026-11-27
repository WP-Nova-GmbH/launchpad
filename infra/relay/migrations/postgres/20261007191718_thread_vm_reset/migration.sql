CREATE TABLE "relay_thread_vm_resets" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"allocation_id" varchar(64) NOT NULL UNIQUE,
	"actor_user_id" varchar(191) NOT NULL,
	"expected_generation" integer NOT NULL,
	"saved_disk_operation_id" varchar(64) NOT NULL,
	"native_checkpoint_operation_id" varchar(64) NOT NULL,
	"source_environment_id" varchar(191) NOT NULL,
	"source_sequence" integer NOT NULL,
	"host_id" varchar(191) NOT NULL,
	"template_id" varchar(191) NOT NULL,
	"canonical_key" varchar(512) NOT NULL,
	"branch" text NOT NULL,
	"revision" varchar(64) NOT NULL,
	"phase" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"error_code" varchar(64),
	CONSTRAINT "relay_thread_vm_resets_generation" CHECK ("expected_generation">0 AND "source_sequence">=0),
	CONSTRAINT "relay_thread_vm_resets_revision" CHECK ("revision" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "relay_thread_vm_resets_phase" CHECK ("phase" IN ('pending','creating','committed','importing','completed','cancelling','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "relay_thread_vm_resets_active" ON "relay_thread_vm_resets" ("thread_id") WHERE "phase" NOT IN ('completed','cancelled');--> statement-breakpoint
ALTER TABLE "relay_thread_vm_resets" ADD CONSTRAINT "relay_thread_vm_resets_hakwbr9ZdYqd_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_resets" ADD CONSTRAINT "relay_thread_vm_resets_EFdP8Upja1kl_fkey" FOREIGN KEY ("saved_disk_operation_id") REFERENCES "relay_thread_vm_saved_disks"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_resets" ADD CONSTRAINT "relay_thread_vm_resets_cjd7GzXEx1QJ_fkey" FOREIGN KEY ("native_checkpoint_operation_id") REFERENCES "relay_thread_native_checkpoints"("operation_id");