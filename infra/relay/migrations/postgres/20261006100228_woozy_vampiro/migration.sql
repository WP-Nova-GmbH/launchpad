CREATE TABLE "relay_thread_vm_backups" (
	"operation_id" varchar(64) PRIMARY KEY,
	"allocation_id" varchar(64) NOT NULL,
	"generation" integer NOT NULL,
	"compute_ref" varchar(191) NOT NULL,
	"snapshot_name" varchar(191) NOT NULL UNIQUE,
	"snapshot_id" varchar(191),
	"source_template_id" varchar(191),
	"source_build_id" varchar(64),
	"phase" varchar(16) NOT NULL,
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "relay_thread_vm_backups_generation" CHECK ("generation" > 0),
	CONSTRAINT "relay_thread_vm_backups_phase" CHECK ("phase" IN ('pending','creating','captured','verifying','cleanup','verified','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_backups_active" ON "relay_thread_vm_backups" ("allocation_id") WHERE "phase" IN ('pending','creating','captured','verifying','cleanup');--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_backups_verified" ON "relay_thread_vm_backups" ("allocation_id","verified_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backups" ADD CONSTRAINT "relay_thread_vm_backups_jsVui4OTZhDx_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");