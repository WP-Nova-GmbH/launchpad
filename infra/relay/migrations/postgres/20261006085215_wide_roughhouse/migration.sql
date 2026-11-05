CREATE TABLE "relay_thread_vm_pauses" (
	"allocation_id" varchar(64) PRIMARY KEY,
	"operation_id" varchar(64) NOT NULL UNIQUE,
	"generation" integer NOT NULL,
	"phase" varchar(16) NOT NULL,
	"boot_id" varchar(64),
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_vm_pauses_generation" CHECK ("generation" > 0),
	CONSTRAINT "relay_thread_vm_pauses_phase" CHECK ("phase" IN ('pending','sealed','completed','cancelled')),
	CONSTRAINT "relay_thread_vm_pauses_sealed_boot" CHECK ("phase" != 'sealed' OR "boot_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_pauses_retry" ON "relay_thread_vm_pauses" ("phase","retry_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_pauses" ADD CONSTRAINT "relay_thread_vm_pauses_cIzDCmHosAe3_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");