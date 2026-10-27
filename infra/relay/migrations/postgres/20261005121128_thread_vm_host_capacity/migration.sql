CREATE TABLE "relay_thread_vm_capacity" (
	"operation_id" varchar(64) PRIMARY KEY,
	"allocation_id" varchar(64) NOT NULL,
	"host_id" varchar(191) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"position" bigserial,
	"state" varchar(16) DEFAULT 'waiting' NOT NULL,
	"compute_ref" varchar(191),
	CONSTRAINT "relay_thread_vm_capacity_kind" CHECK ("kind" IN ('create', 'resume')),
	CONSTRAINT "relay_thread_vm_capacity_state" CHECK ("state" IN ('waiting', 'reserved', 'started', 'released'))
);
--> statement-breakpoint
CREATE TABLE "relay_thread_vm_hosts" (
	"host_id" varchar(191) PRIMARY KEY,
	"max_running_vms" integer NOT NULL,
	CONSTRAINT "relay_thread_vm_hosts_limit" CHECK ("max_running_vms" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_capacity_live_allocation" ON "relay_thread_vm_capacity" ("allocation_id") WHERE "state" != 'released';--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_capacity_waiting" ON "relay_thread_vm_capacity" ("host_id","position") WHERE "state" = 'waiting';--> statement-breakpoint
ALTER TABLE "relay_thread_vm_capacity" ADD CONSTRAINT "relay_thread_vm_capacity_aOrvvMYmCa9G_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_capacity" ADD CONSTRAINT "relay_thread_vm_capacity_uDCjHdaptpgk_fkey" FOREIGN KEY ("host_id") REFERENCES "relay_thread_vm_hosts"("host_id");