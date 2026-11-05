CREATE TABLE "relay_thread_vm_resumes" (
	"allocation_id" varchar(64) PRIMARY KEY,
	"operation_id" varchar(64) NOT NULL UNIQUE,
	"generation" integer NOT NULL,
	"phase" varchar(16) NOT NULL,
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_vm_resumes_generation" CHECK ("generation" > 0),
	CONSTRAINT "relay_thread_vm_resumes_phase" CHECK ("phase" IN ('waiting','resuming','completed'))
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_resumes_retry" ON "relay_thread_vm_resumes" ("phase","retry_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_resumes" ADD CONSTRAINT "relay_thread_vm_resumes_ne0zkIKDmc4e_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");