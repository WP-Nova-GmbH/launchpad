CREATE TABLE "relay_thread_vm_leases" (
	"allocation_id" varchar(64) PRIMARY KEY,
	"attempted_at" timestamp with time zone,
	"renewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_leases" ADD CONSTRAINT "relay_thread_vm_leases_IKDcwy1gf4l5_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");