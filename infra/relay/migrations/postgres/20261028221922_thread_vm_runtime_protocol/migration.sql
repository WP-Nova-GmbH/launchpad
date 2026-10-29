ALTER TABLE "relay_thread_vm_allocations" ADD COLUMN "runtime_protocol" varchar(16) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_allocations" ALTER COLUMN "runtime_protocol" SET DEFAULT 'native-v1';
