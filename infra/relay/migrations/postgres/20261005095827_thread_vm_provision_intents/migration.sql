CREATE TABLE "relay_thread_vm_provisions" (
	"allocation_id" varchar(64) PRIMARY KEY,
	"operation_id" varchar(64) NOT NULL UNIQUE,
	"generation" integer NOT NULL,
	"position" bigserial,
	"phase" varchar(16) DEFAULT 'pending' NOT NULL,
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"error_code" varchar(48),
	CONSTRAINT "relay_thread_vm_provisions_generation" CHECK ("generation" > 0),
	CONSTRAINT "relay_thread_vm_provisions_phase" CHECK ("phase" IN ('pending', 'creating', 'created', 'cancelled')),
	CONSTRAINT "relay_thread_vm_provisions_claim" CHECK (("claim_id" IS NULL) = ("claim_until" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_provisions_pending" ON "relay_thread_vm_provisions" ("position") WHERE "phase" IN ('pending', 'creating');--> statement-breakpoint
ALTER TABLE "relay_thread_vm_provisions" ADD CONSTRAINT "relay_thread_vm_provisions_cszgSSUAUIG6_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");