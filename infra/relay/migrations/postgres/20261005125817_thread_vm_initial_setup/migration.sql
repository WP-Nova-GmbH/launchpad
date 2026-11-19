CREATE TABLE "relay_thread_vm_setups" (
	"allocation_id" varchar(64) PRIMARY KEY,
	"canonical_key" varchar(512) NOT NULL,
	"branch" text NOT NULL,
	"revision" varchar(64) NOT NULL,
	"phase" varchar(16) DEFAULT 'pending' NOT NULL,
	"environment_id" varchar(191),
	"error_code" varchar(64),
	"receipt_sha256" varchar(64),
	CONSTRAINT "relay_thread_vm_setups_phase" CHECK ("phase" IN ('pending', 'running', 'ready', 'failed')),
	CONSTRAINT "relay_thread_vm_setups_revision" CHECK ("revision" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "relay_thread_vm_setups_ready" CHECK ("phase" <> 'ready' OR ("environment_id" IS NOT NULL AND "receipt_sha256" IS NOT NULL AND "receipt_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_setups" ADD CONSTRAINT "relay_thread_vm_setups_KwD3AVCkh8Mi_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");