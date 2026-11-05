ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "serving_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "probe_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "boot_prepare_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "boot_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "idx_relay_thread_vm_restores_active";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_restores_active" ON "relay_thread_vm_restores" ("thread_id") WHERE "phase" NOT IN ('aborted','completed');--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_boot_started" CHECK ("boot_prepare_started_at" IS NULL OR ("serving_requested" AND "probe_removed_at" IS NOT NULL AND "prepared_receipt" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_boot_prepared" CHECK ("phase" NOT IN ('boot_prepared','committed','booted','importing','completed') OR ("boot_prepare_started_at" IS NOT NULL AND "boot_receipt" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" ADD CONSTRAINT "relay_thread_vm_restores_committed" CHECK (("committed_at" IS NOT NULL) = ("phase" IN ('committed','booted','importing','completed')));--> statement-breakpoint
ALTER TABLE "relay_thread_vm_restores" DROP CONSTRAINT "relay_thread_vm_restores_phase", ADD CONSTRAINT "relay_thread_vm_restores_phase" CHECK ("phase" IN ('pending','preparing','prepared','boot_preparing','boot_prepared','committed','booted','importing','completed','aborting','aborted'));