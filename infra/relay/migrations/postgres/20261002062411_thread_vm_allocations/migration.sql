CREATE TABLE "relay_thread_vm_allocations" (
	"allocation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"organization_id" varchar(64) NOT NULL,
	"owner_user_id" varchar(191) NOT NULL,
	"template_id" varchar(191) NOT NULL,
	"compute_ref" varchar(191),
	"state" varchar(16) NOT NULL,
	"deleted_at" varchar(64),
	CONSTRAINT "relay_thread_vm_allocations_state" CHECK ("state" IN ('creating','running','paused','deleting','deleted')),
	CONSTRAINT "relay_thread_vm_allocations_deletion" CHECK (("state" = 'deleted') = ("deleted_at" IS NOT NULL)),
	CONSTRAINT "relay_thread_vm_allocations_compute_required" CHECK ("state" NOT IN ('running','paused') OR "compute_ref" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "relay_thread_vm_policies" (
	"organization_id" varchar(64) PRIMARY KEY,
	"revision" integer DEFAULT 1 NOT NULL,
	"max_vms_per_user" integer DEFAULT 3 NOT NULL,
	"pause_after_idle_minutes" integer DEFAULT 30 NOT NULL,
	"delete_after_idle_weekdays" integer DEFAULT 2 NOT NULL,
	"backup_interval_minutes" integer DEFAULT 15 NOT NULL,
	"saved_disk_retention_days" integer DEFAULT 30 NOT NULL,
	"calendar_time_zone" text DEFAULT 'UTC' NOT NULL,
	CONSTRAINT "relay_thread_vm_policies_limits" CHECK ("revision" > 0 AND "max_vms_per_user" >= 0 AND "pause_after_idle_minutes" > 0 AND "delete_after_idle_weekdays" > 0 AND "backup_interval_minutes" > 0 AND "saved_disk_retention_days" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_allocations_live_thread" ON "relay_thread_vm_allocations" ("thread_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_allocations_compute" ON "relay_thread_vm_allocations" ("compute_ref");--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_allocations_owner" ON "relay_thread_vm_allocations" ("owner_user_id","deleted_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_allocations" ADD CONSTRAINT "relay_thread_vm_allocations_kcXgfcACNnre_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");