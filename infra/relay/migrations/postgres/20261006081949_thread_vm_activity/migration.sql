CREATE TABLE "relay_thread_vm_activity" (
	"allocation_id" varchar(64) PRIMARY KEY,
	"revision" bigint DEFAULT 0 NOT NULL,
	"activity" varchar(16) DEFAULT 'unknown' NOT NULL,
	"observed_at" timestamp with time zone,
	"idle_since" timestamp with time zone,
	"last_work_at" timestamp with time zone,
	CONSTRAINT "relay_thread_vm_activity_state" CHECK ("activity" IN ('busy','idle','unknown')),
	CONSTRAINT "relay_thread_vm_activity_idle_since" CHECK ("activity" <> 'idle' OR "idle_since" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_activity" ADD CONSTRAINT "relay_thread_vm_activity_IY8SVqknlS8T_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");